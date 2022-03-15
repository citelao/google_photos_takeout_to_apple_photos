import fs from "fs";
import path from "path";
import Logger from "./Logger";

export function getGooglePhotosDirsFromTakeoutDir(takeout_dir: string): string[] {
    const files = fs.readdirSync(takeout_dir, { withFileTypes: true });

    // TODO: handle someone giving the "Google Photos" directory or a directory containing Google Photos directly.
    const dirs = files.filter((f)=> f.isDirectory());
    const google_photos_dirs = dirs.map((f) => path.join(takeout_dir, f.name, "Google Photos"));
    
    google_photos_dirs.filter((d) => {
        const doesExist = fs.existsSync(d);
        if (!doesExist) {
            Logger.warn(`Ignoring ${d} (doesn't exist).`);
        }
        return doesExist;
    });
    
    return google_photos_dirs;
}

export interface AlbumFolder {
    name: string;
    dirs: string[];
}
export function getAlbumFolders(google_photos_dirs: string[]): AlbumFolder[] {
    const albumFolders = google_photos_dirs.map((d) => {
        const files = fs.readdirSync(d, { withFileTypes: true });
        const dirs = files.filter((f)=> f.isDirectory());
        const full_dirs = dirs.map((f) => path.join(d, f.name));
        return full_dirs;
    }).flat().reduce<{ name: string; dirs: string[]; }[]>((acc, cur) => {
        const album_title = path.basename(cur);
        const existing = acc.find((v) => v.name === album_title);
        if (existing) {
            existing.dirs.push(cur);
        } else {
            acc.push({
                name: album_title,
                dirs: [cur],
            });
        }
        return acc;
    }, []);

    return albumFolders;
}