import fs from "fs";
import stripAnsi from "strip-ansi";

export default class Logger {
    public static LOG_FILE = `log-${new Date().toISOString()}.log`;

    public static log(t?: unknown, ...params: unknown[]) {
        if (params.length > 0) {
            console.log(t, params);
        } else {
            console.log(t);
        }
        const items = [t, ...params].map((i) => {
            if (typeof i === "string") {
                return stripAnsi(i);
            }

            return i;
        });
        fs.appendFileSync(this.LOG_FILE, JSON.stringify(items, undefined, 4));
    }

    public static warn(t?: unknown, ...params: unknown[]) {
        if (params.length > 0) {
            console.warn(t, params);
        } else {
            console.warn(t);
        }
        fs.appendFileSync(this.LOG_FILE, JSON.stringify(["WARN", t, ...params], undefined, 4));
    }
}