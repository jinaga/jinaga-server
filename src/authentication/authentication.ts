import { FactRecord, Fork, LoginResponse } from "jinaga";

export interface Authentication extends Fork {
    login(): Promise<LoginResponse>;
    local(): Promise<FactRecord>;
}