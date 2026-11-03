import { ChatResponse } from "@server/types";
import { DEFAULT_CHAT_CONFIG, DEFAULT_HANDLE_CONFIG, DEFAULT_MESSAGE_CONFIG } from "./constants";
import type { ChatSerializerMutliParams, ChatSerializerSingleParams } from "./types";
import { MessageSerializer } from "./MessageSerializer";
import { HandleSerializer } from "./HandleSerializer";
import { isChatFilteredAsSpam } from "./chatSpam";
import { groupingFields, ChatGroupingFields } from "./chatGroupIds";
import { Server } from "@server";

export class ChatSerializer {
    static async serialize({
        chat,
        config = DEFAULT_CHAT_CONFIG,
        messageConfig = DEFAULT_MESSAGE_CONFIG,
        handleConfig = DEFAULT_HANDLE_CONFIG,
        isForNotification = false
    }: ChatSerializerSingleParams): Promise<ChatResponse> {
        return (
            await ChatSerializer.serializeList({
                chats: [chat],
                config: { ...DEFAULT_CHAT_CONFIG, ...config },
                messageConfig: { ...DEFAULT_MESSAGE_CONFIG, ...messageConfig },
                handleConfig: { ...DEFAULT_HANDLE_CONFIG, ...handleConfig },
                isForNotification
            })
        )[0];
    }

    static async serializeList({
        chats,
        config = DEFAULT_CHAT_CONFIG,
        messageConfig = DEFAULT_MESSAGE_CONFIG,
        handleConfig = DEFAULT_HANDLE_CONFIG,
        isForNotification = false
    }: ChatSerializerMutliParams): Promise<ChatResponse[]> {
        // Fetched for the whole list at once: two queries however many chats.
        const grouping = isForNotification
            ? new Map()
            : await groupingFields(
                  (sql, params) => Server().iMessageRepo.db.query(sql, params),
                  chats.filter(c => c?.ROWID != null)
              ).catch(() => new Map());
        return Promise.all(
            chats.map(
                async chat =>
                    await ChatSerializer.convert({
                        grouping: grouping.get(chat?.ROWID),
                        chat,
                        config: { ...DEFAULT_CHAT_CONFIG, ...config },
                        messageConfig: { ...DEFAULT_MESSAGE_CONFIG, ...messageConfig },
                        handleConfig: { ...DEFAULT_HANDLE_CONFIG, ...handleConfig },
                        isForNotification
                    })
            )
        );
    }

    private static async convert({
        chat,
        grouping = null,
        config = DEFAULT_CHAT_CONFIG,
        messageConfig = DEFAULT_MESSAGE_CONFIG,
        handleConfig = DEFAULT_HANDLE_CONFIG,
        isForNotification = false
    }: ChatSerializerSingleParams & { grouping?: ChatGroupingFields | null }): Promise<ChatResponse> {
        let output: ChatResponse = {
            originalROWID: chat.ROWID,
            guid: chat.guid,
            style: chat.style,
            chatIdentifier: chat.chatIdentifier,
            // On macOS 26 every chat GUID starts with `any;`, so the GUID no
            // longer says whether a chat is iMessage, SMS or RCS. This does.
            serviceName: chat.serviceName,
            isArchived: chat.isArchived,
            displayName: chat.displayName,
            // Included in notifications too: the first message from a new spam
            // sender arrives by push, before any chat sync.
            isFilteredAsSpam: isChatFilteredAsSpam(chat.properties)
        };

        if (config.includeParticipants) {
            output.participants = await HandleSerializer.serializeList({
                handles: chat?.participants ?? [],
                config: {
                    ...handleConfig,
                    includeChats: false
                },
                messageConfig,
                chatConfig: config,
                isForNotification
            });
        }

        if (config.includeMessages) {
            output.messages = await MessageSerializer.serializeList({
                messages: chat?.messages ?? [],
                config: {
                    ...messageConfig,
                    includeChats: false
                },
                isForNotification
            });
        }

        if (!isForNotification) {
            output = {
                ...output,
                ...{
                    isFiltered: chat.isFiltered,
                    groupId: chat.groupId,
                    // Every copy of one conversation shares one of these ids;
                    // the client groups copies into one thread with them.
                    originalGroupId: grouping?.originalGroupId ?? null,
                    legacyGroupIds: grouping?.legacyGroupIds ?? [],
                    latestGroupTitle: grouping?.latestGroupTitle ?? null,
                    properties: chat.properties,
                    lastAddressedHandle: chat.lastAddressedHandle
                }
            };
        }

        return output;
    }
}
