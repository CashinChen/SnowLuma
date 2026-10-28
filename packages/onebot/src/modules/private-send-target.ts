import { createLogger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type { MessageStore } from '../message-store';
import { TEMP_SESSION_TTL_MS, type TempSessionStore } from '../temp-session-store';
import type { JsonObject, JsonValue } from '../types';

const log = createLogger('OneBot');

/** How many stored events to scan back for the peer's latest inbound message. */
const INBOUND_SCAN_LIMIT = 50;

/** The slice of the instance context this resolver needs. */
export interface PrivateSendTargetRef {
    bridge: Pick<BridgeInterface, 'identity'>;
    messageStore: Pick<MessageStore, 'listSessionEvents'>;
    tempSessions: Pick<TempSessionStore, 'record'>;
}

/**
 * Pick the source group a private send has to target.
 *
 * QQ delivers a message to a non-friend only through the group temp session
 * (临时会话) that peer opened, and the wire request must name the source group.
 * OneBot clients that only know `user_id` can't supply it, so recover it from
 * the peer's latest inbound private message, whose `sender.group_id` already
 * carries the source group (see event-converter/to-message.ts).
 *
 * Friends always take the direct c2c chat: a stale source group would make QQ
 * reject the send or route it into a temp session nobody asked for.
 */
export async function resolvePrivateSendGroupId(
    ref: PrivateSendTargetRef,
    userId: number,
    explicitGroupId?: number,
): Promise<number | undefined> {
    if (!Number.isInteger(userId) || userId <= 0) {
        return undefined;
    }

    if (ref.bridge.identity.findFriend(userId)) {
        if (explicitGroupId !== undefined && explicitGroupId > 0) {
            log.debug(
                'ignoring group_id=%d for friend private send user=%d',
                explicitGroupId,
                userId,
            );
        }

        return undefined;
    }

    if (explicitGroupId !== undefined && explicitGroupId > 0) {
        return explicitGroupId;
    }

    const groupId = await latestInboundGroupId(ref.messageStore, userId);

    if (groupId === undefined) {
        return undefined;
    }

    // The passive guard in sendPrivateMessage only accepts sessions the peer
    // opened. This stored inbound message is exactly that evidence, so record it
    // before sending (which also refreshes the reply window).
    ref.tempSessions.record(userId, groupId);
    log.debug('private send user=%d resolved to temp session group=%d', userId, groupId);
    return groupId;
}

/** Source group of the peer's newest inbound private message, if it still counts. */
async function latestInboundGroupId(
    messageStore: PrivateSendTargetRef['messageStore'],
    userId: number,
): Promise<number | undefined> {
    const events = await messageStore.listSessionEvents(false, userId, INBOUND_SCAN_LIMIT);

    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];

        // Self-sent rows carry the bot's own user_id, so this keeps them out.
        if (toPositiveInt(event.user_id) !== userId) {
            continue;
        }

        return freshSenderGroupId(event);
    }

    return undefined;
}

/** `sender.group_id` of one inbound event, when its temp session is still fresh. */
function freshSenderGroupId(event: JsonObject): number | undefined {
    const groupId = senderGroupId(event.sender);

    if (groupId === undefined) {
        return undefined;
    }

    const seconds = toPositiveInt(event.time);

    if (seconds === undefined) {
        return groupId;
    }

    return Date.now() - seconds * 1000 > TEMP_SESSION_TTL_MS ? undefined : groupId;
}

function senderGroupId(sender: JsonValue | undefined): number | undefined {
    if (typeof sender !== 'object' || sender === null || Array.isArray(sender)) {
        return undefined;
    }

    return toPositiveInt((sender as JsonObject).group_id);
}

function toPositiveInt(value: JsonValue | undefined): number | undefined {
    const int =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && value.trim()
              ? Number(value)
              : Number.NaN;
    return Number.isInteger(int) && int > 0 ? int : undefined;
}
