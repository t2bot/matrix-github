import { MatrixEvent } from "../MatrixEvent";

export const BRIDGE_ROOM_TYPE = "uk.half-shot.matrix-github.room";

export interface BridgeRoom {
    /**
     * 
     * @param event The matrix event
     * @param isOurs Did the event originate from the bridge.
     * @returns True if the event should be consumed, otherwise false.
     */
    onEvent(event: MatrixEvent<unknown>, isOurs: boolean): Promise<boolean>;
}

export interface BridgeRoomAccountData {
    type: string;
}