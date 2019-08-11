import { BridgeRoom, BridgeRoomAccountData, BRIDGE_ROOM_TYPE } from "./BridgeRoom";
import { MatrixEvent, MatrixMessageContent, MatrixEventContent } from "../MatrixEvent";
import { Intent, Appservice } from "matrix-bot-sdk";
import { BRIDGE_STATE_TYPE, BridgeRoomStateContent } from "../BridgeState";
import { LogWrapper } from "../LogWrapper";
import Octokit from "@octokit/rest";
import { createMessageQueue, MessageQueue } from "../MessageQueue/MessageQueue";
import { BridgeConfig } from "../Config";
import { IMatrixSendMessageResponse, IMatrixSendMessage } from "../MatrixSender";
import markdown from "markdown-it";
import { FormatUtil } from "../FormatUtil";

export interface AdminAccountData extends BridgeRoomAccountData {
    type: "issue",
    issue_number: number;
    owner: string;
    repo: string;
}

const log = new LogWrapper("IssueRoom");

const md = new markdown();

export class IssueRoom implements BridgeRoom {
    private roomState?: BridgeRoomStateContent;
    private queue: MessageQueue;

    public get state(): BridgeRoomStateContent{
        return this.roomState!;
    }

    public get issue(): number {
        return parseInt(this.roomState!.issues[0]);
    }

    constructor(public readonly roomId: string, private intent: Intent, config: BridgeConfig) {
        this.queue = createMessageQueue(config);
    }

    public async onEvent(event: MatrixEvent<unknown>) {
        const roomStateContent = this.roomState!;
        // NOTE: m.room.message is currently handled in GithubBridge
        const ident = `${roomStateContent.org}/${roomStateContent.repo}#${roomStateContent.issues[0]}`;

        log.info(`Got new request for ${ident}`);
        if (event.type === BRIDGE_STATE_TYPE && event.state_key === "") {
            log.info(`Got new state for ${this.roomId}`);
            await this.getRoomState();
            // Get current state of issue.
            // await this.syncIssueState(roomId, state);
            return true;
        }
        return false;
    }

    public async getRoomState() {
        try {
            this.roomState = await this.intent.underlyingClient.getRoomStateEvent(this.roomId, BRIDGE_STATE_TYPE, "");
            return;
        } catch (ex) {
            log.warn(`No state for ${this.roomId}. Checking for legacy state`);
        }
        // Previously we used to store multiple state events per room, which makes them hard to track. Let's check for any state.
        const allState: MatrixEvent<unknown>[] = await this.intent.underlyingClient.getRoomState(this.roomId);
        const bridgeState = allState.filter(m => m.type === BRIDGE_STATE_TYPE);
        if (bridgeState.length === 0) {
            throw new Error("No state could be found");
        }
        // We never really used or permitting multiple state per room, so just reassign the state to empty.
        this.roomState = bridgeState[0].content as BridgeRoomStateContent;
        await this.intent.underlyingClient.sendStateEvent(this.roomId, BRIDGE_STATE_TYPE, "", bridgeState[0].content);
    }

    public async migrateLegacyRoom() {
        // First, get the current room state.
        await this.getRoomState(); // This may throw if state couldn't be found.
        await this.intent.underlyingClient.setRoomAccountData(BRIDGE_ROOM_TYPE, this.roomId, {
            issue_number: parseInt(this.roomState!.issues[0]),
            owner: this.roomState!.org,
            repo: this.roomState!.repo,
            type: "issue",
        } as BridgeRoomAccountData);
    }

    public async syncIssueState(octokit: Octokit, as: Appservice) {
        log.debug("Syncing issue state for", this.roomId);
        const issue = await octokit.issues.get({
            owner: this.state.org,
            repo: this.state.repo,
            issue_number: this.issue,
        });
        const creatorUserId = as.getUserIdForSuffix(issue.data.user.login);

        if (this.state.comments_processed === -1) {
            // We've not sent any messages into the room yet, let's do it!
            await this.sendMatrixText(
                "This bridge currently only supports invites to 1:1 rooms",
                "m.notice",
                creatorUserId,
            );
            if (issue.data.body) {
                await this.sendMatrixMessage({
                    msgtype: "m.text",
                    external_url: issue.data.html_url,
                    body: `${issue.data.body} (${issue.data.updated_at})`,
                    format: "org.matrix.custom.html",
                    formatted_body: md.render(issue.data.body),
                }, "m.room.message", creatorUserId);
            }
            if (issue.data.pull_request) {
                // Send a patch in
            }
            this.state.comments_processed = 0;
        }

        // TODO: Refactor this.
        // if (repoState.content.comments_processed !== issue.data.comments) {
        //     const comments = (await this.octokit.issues.listComments({
        //         owner: repoState.content.org,
        //         repo: repoState.content.repo,
        //         issue_number: parseInt(repoState.content.issues[0], 10),
        //         // TODO: Use since to get a subset
        //     })).data.slice(repoState.content.comments_processed);
        //     for (const comment of comments) {
        //         await this.onCommentCreated({
        //             comment,
        //             action: "fake",
        //         }, roomId, false);
        //         repoState.content.comments_processed++;
        //     }
        // }

        if (this.state.state !== issue.data.state) {
            if (issue.data.state === "closed") {
                const closedUserId = as.getUserIdForSuffix(issue.data.closed_by.login);
                await this.sendMatrixMessage({
                    msgtype: "m.notice",
                    body: `closed the ${issue.data.pull_request ? "pull request" : "issue"} at ${issue.data.closed_at}`,
                    external_url: issue.data.closed_by.html_url,
                }, "m.room.message", closedUserId);
            }

            await as.botIntent.underlyingClient.sendStateEvent(this.roomId, "m.room.topic", "", {
                topic: FormatUtil.formatTopic(issue.data),
            });
            this.state.state = issue.data.state;
        }

        await as.botIntent.underlyingClient.sendStateEvent(
            this.roomId,
            BRIDGE_STATE_TYPE,
            "",
            this.state,
        );
    }

    private async sendMatrixText(text: string, msgtype: string = "m.text", sender: string|null = null): Promise<string> {
        return this.sendMatrixMessage({
            msgtype,
            body: text,
        } as MatrixMessageContent, "m.room.message", sender);
    }

    private async sendMatrixMessage(content: MatrixEventContent, eventType: string = "m.room.message",
        sender: string|null = null): Promise<string> {
        return (await this.queue.pushWait<IMatrixSendMessage, IMatrixSendMessageResponse>({
            eventName: "matrix.message",
            sender: "GithubBridge",
            data: {
                roomId: this.roomId,
                type: eventType,
                sender,
                content,
            },
        })).eventId;
    }

}