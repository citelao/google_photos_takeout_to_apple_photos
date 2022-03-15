import plist from "plist";
import { program } from "commander";
import fs from "fs";

interface IPhotoSweeperOutput {
    Results: Array<{
        Files: Array<{
            path: string;
            isMarked: string;
        }>;
        GroupName: string;
    }>;
}

program
    .argument('<photosweeper_output>', 'plist/xml output from PhotoSweeper')
    .option("-d --do_action", "actually do stuff")
    .action(async (photosweeper_output: string) => {
        const do_action: boolean = program.opts().do_action;

        const content = fs.readFileSync(photosweeper_output);
        const parsed = plist.parse(content.toString("utf8")) as any as IPhotoSweeperOutput;
        console.dir(parsed.Results, { depth: 2 });
    });

program.parse();
