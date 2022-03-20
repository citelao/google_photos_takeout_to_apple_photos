import fs from "fs";
import stripAnsi from "strip-ansi";
import path from "path";
import os from "os";
import crypto from "crypto";

export default class Logger {
    public static RUN_ID = new Date().toISOString();
    public static LOG_FILE = `log-${Logger.RUN_ID}.log`;

    public static log(t?: unknown, ...params: unknown[]) {
        if (!t) {
            console.log();
            fs.appendFileSync(this.LOG_FILE, "\n");
            return;
        }

        if (params.length > 0) {
            console.log(t, ...params);
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
        if (!t) {
            console.warn();
            fs.appendFileSync(this.LOG_FILE, "\n");
            return;
        }

        if (params.length > 0) {
            console.warn(t, ...params);
        } else {
            console.warn(t);
        }
        fs.appendFileSync(this.LOG_FILE, JSON.stringify(["WARN", t, ...params], undefined, 4));
    }

    public static verbose(t?: unknown, ...params: unknown[]) {
        if (!t) {
            fs.appendFileSync(this.LOG_FILE, "\n");
            return;
        }

        const items = [t, ...params].map((i) => {
            if (typeof i === "string") {
                return stripAnsi(i);
            }

            return i;
        });
        fs.appendFileSync(this.LOG_FILE, JSON.stringify(items, undefined, 4));
    }

    public static getTemporaryFolder(): string {
        const renamedFilesDir = path.join(os.tmpdir(), "google_photos_to_apple_photos", Logger.RUN_ID);
        fs.mkdirSync(renamedFilesDir, { recursive: true });

        return renamedFilesDir;
    }

    public static getTemporaryFileName(): string {
        const filename = crypto.randomUUID();
        return path.join(this.getTemporaryFolder(), filename);
    }

    public static getFileOrFallbackTemporaryFile(desiredPath: string): string {
        if (fs.existsSync(desiredPath)) {
            const newFile = this.getTemporaryFileName();
            Logger.warn(`Output file '${desiredPath}' exists, using ${newFile} instead`);
            return newFile;
        }

        return desiredPath;
    }
}