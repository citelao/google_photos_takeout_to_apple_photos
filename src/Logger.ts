import fs from "fs";

export default class Logger {
    public static LOG_FILE = `log-${new Date().toISOString()}.log`;

    public static log(t?: unknown, ...params: unknown[]) {
        console.log(t, params);
        fs.appendFileSync(this.LOG_FILE, JSON.stringify([t, ...params], undefined, 4));
    }

    public static warn(t?: unknown, ...params: unknown[]) {
        console.warn(t, params);
        fs.appendFileSync(this.LOG_FILE, JSON.stringify(["WARN", t, ...params], undefined, 4));
    }
}