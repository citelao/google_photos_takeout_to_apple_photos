import { execAsync } from "./exec";

export interface ExifToolOutput {
    SourceFile: string;
    // ...many other things...
    File: {
        FileModifyDate: number | undefined;
    }
    MakerNotes: {
        ContentIdentifier: string | undefined;
    } | undefined,
    Composite: {
        GPSLatitude: string | number | undefined;
        GPSLongitude: string | number | undefined;

        // File creation
        SubSecCreateDate: number | undefined;

        // Image taken
        SubSecDateTimeOriginal: number | undefined;
    }
}

export async function getExifToolData(path: string): Promise<ExifToolOutput> {
    const PRECISION = 6;
    const result = await execAsync(`exiftool -g -json -d "%s" -c "%+.${PRECISION}f" "${path}"`);
    const json = JSON.parse(result.stdout)[0];
    // Logger.log(json);
    return json;
}

export async function getExifToolDataForDirectory(dirPath: string): Promise<[ExifToolOutput]> {
    const PRECISION = 6;
    const result = await execAsync(`exiftool -g -json -d "%s" -c "%+.${PRECISION}f" "${dirPath}"`);
    const json = JSON.parse(result.stdout);
    return json;
}

export interface FfprobeOutput {
    // ...many other things...
    format: {
        filename: string;
        tags: {
            "com.apple.quicktime.content.identifier": string | undefined;
        }
    }
}
export async function getFfprobeData(path: string): Promise<FfprobeOutput> {
    const result = await execAsync(`ffprobe -print_format json -v quiet -hide_banner -show_format "${path}"`);
    // Logger.log(result.stdout);
    const json = JSON.parse(result.stdout);
    return json;
}

// async function getImageMetadata(path: string): Promise<any> {
//     const exifToolData = await getExifToolData(path);

//     // if (exifToolData.MakerNotes && "ContentIdentifier" in exifToolData.MakerNotes)
//     // {
//     //     Logger.log(exifToolData.MakerNotes.ContentIdentifier);
//     // }

//     // if (exifToolData.Composite)
//     // {
//     //     Logger.log(exifToolData.Composite.GPSLatitude);
//     //     Logger.log(exifToolData.Composite.GPSLongitude);
//     // }

//     return {};
// }