import { BridgeRoom, BridgeRoomAccountData, BRIDGE_ROOM_TYPE } from "./BridgeRoom";
import { Intent } from "matrix-bot-sdk";
import { LogWrapper } from "../LogWrapper";
import { AdminRoom, AdminAccountData } from "./AdminRoom";
import { UserTokenStore } from "../UserTokenStore";
import { BridgeConfig } from "../Config";
import { IssueRoom } from "./IssueRoom";

const log = new LogWrapper("RoomStore");

export class RoomStore {

    private adminRooms: Map<string, AdminRoom>;
    private issueRooms: Map<string, IssueRoom>;

    constructor(private intent: Intent, private tokenStore: UserTokenStore, private config: BridgeConfig) {
        this.adminRooms = new Map();
        this.issueRooms = new Map();
    }

    public async initStore() {
        const joinedRooms = await this.intent.underlyingClient.getJoinedRooms();
        log.info(`Fetched ${joinedRooms.length} joined rooms for the bridge`);
        const statePromises: Promise<unknown>[] = [];
        for (const roomId of joinedRooms) {
            log.info("Fetching account data for " + roomId);
            let accountData!: BridgeRoomAccountData;
            try {
                accountData = await this.intent.underlyingClient.getRoomAccountData(
                    BRIDGE_ROOM_TYPE, roomId,
                );
            } catch (ex) {
                log.warn(`Ignorning ${roomId}. No account data defined.`);
                // We have no stored information about this room.
            }
            if (accountData.type === "admin") {
                const adminAccountData = accountData as AdminAccountData;
                this.adminRooms.set(roomId, new AdminRoom(
                    roomId, adminAccountData.admin_user, this.intent, this.tokenStore, this.config,
                ));
            } else if (accountData.type === "issue") {
                const issueRoom = new IssueRoom(
                    roomId,
                    this.intent,
                );
                this.issueRooms.set(roomId, issueRoom);
                statePromises.push(issueRoom.getRoomState());
            } else {
                // This room has some account data, but we do not understand it. Possibly
                // it was created manually or by a future version of this software.
                try {
                    // This could be a legacy issue room. Check its room state and confirm.
                    const legacyIssueRoom = new IssueRoom(roomId, this.intent);
                    await legacyIssueRoom.migrateLegacyRoom();
                    this.issueRooms.set(roomId, legacyIssueRoom);
                } catch (ex) {
                    log.error(`Failed to migrate ${roomId}: ${ex}`);
                }
            }
        }
        await Promise.all(statePromises);
    }

    public addRoom(roomId: string, room: BridgeRoom) {

    }

    public getRoom(roomId: string): BridgeRoom|undefined {
        return this.issueRooms.get(roomId) || this.adminRooms.get(roomId);
    }

    public getWithOauthState(state: string): AdminRoom|undefined {
        return [...this.adminRooms.values()].find((r)  => r.oauthState === state);
    }
}