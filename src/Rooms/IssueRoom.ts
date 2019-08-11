import { BridgeRoom, BridgeRoomAccountData, BRIDGE_ROOM_TYPE } from "./BridgeRoom";
import { MatrixEvent } from "../MatrixEvent";
import { Intent } from "matrix-bot-sdk";
import { BRIDGE_STATE_TYPE, IBridgeRoomState } from "../BridgeState";
import { LogWrapper } from "../LogWrapper";

export interface AdminAccountData extends BridgeRoomAccountData {
    type: "issue",
    issue_number: number;
    owner: string;
    repo: string;
}

const log = new LogWrapper("IssueRoom");

export class IssueRoom implements BridgeRoom {
    private roomState?: IBridgeRoomState;

    constructor(private roomId: string, private intent: Intent) {

    }

    public async onEvent(event: MatrixEvent<unknown>) {
        const roomStateContent = this.roomState!.content
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
        this.roomState = bridgeState[0].content as IBridgeRoomState;
        await this.intent.underlyingClient.sendStateEvent(this.roomId, BRIDGE_STATE_TYPE, "", bridgeState[0].content);
    }

    public async migrateLegacyRoom() {
        // First, get the current room state.
        await this.getRoomState(); // This may throw if state couldn't be found.
        await this.intent.underlyingClient.setRoomAccountData(BRIDGE_ROOM_TYPE, this.roomId, {
            issue_number: parseInt(this.roomState!.content.issues[0]),
            owner: this.roomState!.content.org,
            repo: this.roomState!.content.repo,
            type: "issue",
        } as BridgeRoomAccountData);
    }
}