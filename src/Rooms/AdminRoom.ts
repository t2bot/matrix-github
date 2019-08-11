import { Intent } from "matrix-bot-sdk";
import Octokit, {  } from "@octokit/rest";
import { UserTokenStore } from "../UserTokenStore";
import { BridgeConfig } from "../Config";
import uuid from "uuid/v4";
import qs from "querystring";
import { BridgeRoom, BridgeRoomAccountData, BRIDGE_ROOM_TYPE } from "./BridgeRoom";
import { MatrixEvent, MatrixMessageContent, MatrixMemberContent } from "../MatrixEvent";

export interface AdminAccountData extends BridgeRoomAccountData {
    type: "admin",
    admin_user: string;
}

export class AdminRoom implements BridgeRoom {

    static async tryCreateNew(memberEvent: MatrixEvent<MatrixMemberContent>, intent: Intent, tokenStore: UserTokenStore, config: BridgeConfig): Promise<AdminRoom|undefined> {
        const roomId = memberEvent.room_id;
        await intent.joinRoom(roomId);
        const adminRoom = new AdminRoom(roomId, memberEvent.sender, intent, tokenStore, config);
        const members = await intent.underlyingClient.getJoinedRoomMembers(roomId);
        if (members.filter((userId) => ![intent.userId, memberEvent.sender].includes(userId)).length !== 0) {
            await adminRoom.sendNotice("This bridge currently only supports invites to 1:1 rooms");
            await intent.underlyingClient.leaveRoom(roomId);
            return;
        }
        return adminRoom;
    }

    private pendingOAuthState: string|null = null;

    constructor(private roomId: string,
                public readonly userId: string,
                private botIntent: Intent,
                private tokenStore: UserTokenStore,
                private config: BridgeConfig) {

    }

    public get oauthState() {
        return this.pendingOAuthState;
    }

    public clearOauthState() {
        this.pendingOAuthState = null;
    }

    public async storeRoom() {
        await this.botIntent.underlyingClient.setRoomAccountData(BRIDGE_ROOM_TYPE, this.roomId, {
            type: "admin",
            admin_user: this.userId,
        } as AdminAccountData);
    }

    public async onEvent(matrixEvent: MatrixEvent<unknown>) {
        if (matrixEvent.type !== "m.room.message") {
            return true;
        }
        if (matrixEvent.sender !== this.userId) {
            return true;
        }
        const command = (matrixEvent as MatrixEvent<MatrixMessageContent>).content.body;
        const cmdLower = command.toLowerCase();
        if (cmdLower.startsWith("!setpersonaltoken ")) {
            const accessToken = command.substr("!setPersonalToken ".length);
            await this.setPersonalAccessToken(accessToken);
        } else if (cmdLower.startsWith("!hastoken")) {
            await this.hasPersonalToken();
        } else if (cmdLower.startsWith("!startoauth")) {
            await this.beginOAuth();
        } else {
            await this.sendNotice("Command not understood");
        }
        // Always consume a command.
        return true;
    }

    private async setPersonalAccessToken(accessToken: string) {
        let me;
        try {
            const octokit = new Octokit({
                auth: accessToken,
                userAgent: "matrix-github v0.0.1",
            });
            me = await octokit.users.getAuthenticated();
        } catch (ex) {
            await this.sendNotice("Could not authenticate with GitHub. Is your token correct?");
            return;
        }
        await this.sendNotice(`Connected as ${me.data.login}. Storing token..`);
        await this.tokenStore.storeUserToken(this.userId, accessToken);
    }

    private async hasPersonalToken() {
        const result = await this.tokenStore.getUserToken(this.userId);
        if (result === null) {
            await this.sendNotice("You do not currently have a token stored");
            return;
        }
        await this.sendNotice("A token is stored for your GitHub account.");
    }

    private async beginOAuth() {
        // If this is already set, calling this command will invalidate the previous session.
        this.pendingOAuthState = uuid();
        const q = qs.stringify({
            client_id: this.config.github.oauth.client_id,
            redirect_uri: this.config.github.oauth.redirect_uri,
            state: this.pendingOAuthState,
        });
        const url = `https://github.com/login/oauth/authorize?${q}`;
        await this.sendNotice(`You should follow ${url} to link your account to the bridge`);
    }

    private async sendNotice(noticeText: string) {
        return this.botIntent.sendText(this.roomId, noticeText, "m.notice");
    }
    // Initiate oauth
    // Relinquish oauth
}
