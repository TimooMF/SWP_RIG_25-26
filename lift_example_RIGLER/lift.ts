// simplified lift implementation — easier to read & reason about
// Added async timings: door open/close = 1s, move one floor = 3s

export enum Direction {
    Up = 1,
    Down = -1,
    Idle = 0,
}

export enum DoorState {
    Open = "open",
    Closed = "closed",
}

export interface Call {
    floor: number;
    direction: Direction.Up | Direction.Down;
}

export class Lift {
    public readonly minFloor: number;
    public readonly maxFloor: number;

    private _currentFloor: number;
    private _direction: Direction = Direction.Idle;
    private _doors: DoorState = DoorState.Closed;

    private readonly panelRequests = new Set<number>();
    private calls: Call[] = [];

    // busy flag to prevent overlapping operations
    private busy = false;

    constructor(minFloor = 1, maxFloor = 10, startFloor = 1) {
        if (minFloor > maxFloor) throw new Error("minFloor must be <= maxFloor");
        if (startFloor < minFloor || startFloor > maxFloor) throw new Error("startFloor out of range");
        this.minFloor = minFloor;
        this.maxFloor = maxFloor;
        this._currentFloor = startFloor;
        this.log(`Initialized at floor ${this._currentFloor}`);
    }

    // --- getters ---
    public get currentFloor() { return this._currentFloor; }
    public get direction() { return this._direction; }
    public get doors() { return this._doors; }
    public get pendingPanelRequests() { return Array.from(this.panelRequests).sort((a,b)=>a-b); }
    public get pendingCalls() { return this.calls.slice(); }

    // --- external commands ---
    public pressButton(floor: number) {
        this.assertFloorInRange(floor);
        this.panelRequests.add(floor);
        this.log(`Panel button pressed: floor ${floor}`);
        this.updateDirectionIfIdle();
    }

    public callFrom(floor: number, direction: Direction.Up | Direction.Down) {
        this.assertFloorInRange(floor);
        this.calls.push({ floor, direction });
        this.log(`Call from floor ${floor} going ${this.dirName(direction)}`);
        this.updateDirectionIfIdle();
    }

    // Opening doors now takes 1s
    public async openDoors() {
        if (this._doors === DoorState.Open) return;
        if (this.busy) throw new Error("Lift is busy");
        this.busy = true;
        this.log(`Opening doors on floor ${this._currentFloor} (1s)`);
        await this.sleep(1000);
        this._doors = DoorState.Open;
        this.log(`Doors open on floor ${this._currentFloor}`);
        this.fulfillAtCurrentFloor();
        if (!this.hasPendingRequests()) {
            this._direction = Direction.Idle;
            this.log(`No pending requests — going idle on floor ${this._currentFloor}`);
        }
        this.busy = false;
    }

    // Closing doors now takes 1s
    public async closeDoors() {
        if (this._doors === DoorState.Closed) return;
        if (this.busy) throw new Error("Lift is busy");
        this.busy = true;
        this.log(`Closing doors on floor ${this._currentFloor} (1s)`);
        await this.sleep(1000);
        this._doors = DoorState.Closed;
        this.log(`Doors closed on floor ${this._currentFloor}`);
        this.updateDirectionIfIdle();
        this.busy = false;
    }

    // Moving one floor now takes 3s
    public async moveOneFloor() {
        if (this._doors === DoorState.Open) throw new Error("Cannot move while doors are open");
        if (this.busy) throw new Error("Lift is busy");
        if (this._direction === Direction.Idle) {
            this.updateDirectionIfIdle();
            if (this._direction === Direction.Idle) throw new Error("No destination to move to");
        }

        const next = this._currentFloor + this._direction;
        if (next < this.minFloor || next > this.maxFloor) {
            // at edge: reverse direction instead of moving out of range
            this._direction = this._direction === Direction.Up ? Direction.Down : Direction.Up;
            this.log(`At edge on floor ${this._currentFloor} — reversing to ${this.dirName(this._direction)}`);
            return;
        }

        this.log(`Moving one floor ${this.dirName(this._direction)} from ${this._currentFloor} to ${next} (3s)`);
        this.busy = true;
        await this.sleep(3000);
        this._currentFloor = next;
        this.busy = false;
        this.log(`On floor ${this._currentFloor}`);
        if (this.shouldStopAtFloor(this._currentFloor)) {
            this.log(`Stopping at floor ${this._currentFloor}`);
            await this.openDoors();
        }
    }

    // stepUntilStop updated to await movement
    public async stepUntilStop(maxSteps = 1000) {
        for (let i = 0; i < maxSteps; i++) {
            if (this._doors === DoorState.Open || this._direction === Direction.Idle) break;
            await this.moveOneFloor();
        }
    }

    // --- helpers (simpler logic) ---
    private assertFloorInRange(floor: number) {
        if (floor < this.minFloor || floor > this.maxFloor) throw new Error("floor out of range");
    }

    private hasPendingRequests() {
        return this.panelRequests.size > 0 || this.calls.length > 0;
    }

    // Pick nearest target floor when idle
    private updateDirectionIfIdle() {
        if (this._direction !== Direction.Idle) return;
        if (!this.hasPendingRequests()) {
            this._direction = Direction.Idle;
            return;
        }

        const targets = [
            ...Array.from(this.panelRequests),
            ...this.calls.map(c => c.floor),
        ];
        if (targets.length === 0) return;

        let nearest = targets[0];
        let bestDist = Math.abs(nearest - this._currentFloor);
        for (const t of targets) {
            const d = Math.abs(t - this._currentFloor);
            if (d < bestDist) {
                nearest = t;
                bestDist = d;
            }
        }
        const newDir = nearest > this._currentFloor ? Direction.Up : (nearest < this._currentFloor ? Direction.Down : Direction.Idle);
        this._direction = newDir;
        if (newDir === Direction.Idle) {
            this.log(`Already at target floor ${this._currentFloor}`);
            // opening doors is async; fire-and-forget here is acceptable
            void this.openDoors();
        } else {
            this.log(`Lift going ${this.dirName(newDir)} towards floor ${nearest}`);
        }
    }

    // Stop if someone inside requested this floor, or if there's a call here.
    // If moving, prefer calls that match the direction; if idle, stop and pick up everyone.
    private shouldStopAtFloor(floor: number) {
        if (this.panelRequests.has(floor)) return true;
        const callsHere = this.calls.filter(c => c.floor === floor);
        if (callsHere.length === 0) return false;
        if (this._direction === Direction.Idle) return true;
        return callsHere.some(c => c.direction === this._direction);
    }

    // Fulfill panel requests and remove any calls at this floor (simpler behavior)
    private fulfillAtCurrentFloor() {
        this.panelRequests.delete(this._currentFloor);
        this.calls = this.calls.filter(c => c.floor !== this._currentFloor);
        this.log(`Fulfilled requests on floor ${this._currentFloor}`);
    }

    // --- timing helper ---
    private sleep(ms: number) {
        return new Promise<void>(resolve => setTimeout(resolve, ms));
    }

    // --- logging helpers ---
    private log(message: string) {
        console.log(`[Lift] ${message}`);
    }

    private dirName(dir: Direction) {
        switch (dir) {
            case Direction.Up: return "up";
            case Direction.Down: return "down";
            default: return "idle";
        }
    }
}

