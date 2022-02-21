import util from "util";
const exec = util.promisify(require('child_process').exec);

export async function execAsync(cmd: string): Promise<{ stdout: string; stderr: string; }> {
    // An absurdly large buffer.
    const result: { stdout: string, stderr: string } = await exec(cmd, { maxBuffer: 1024 * 50000});

    // TODO: handle errors?
    // if (result.stderr) {
    //     throw new Error(`exiftool failed: ${result.stderr}`);
    // }

    return result;
}
