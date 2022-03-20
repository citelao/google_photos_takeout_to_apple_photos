import path from "path";

function getVideoTypes(): string[] {
    const VIDEO_TYPES = [
        ".MOV",
        ".MP4", 
        ".M4V",
    ];
    return VIDEO_TYPES;
}
function getImageTypes(): string[] {
    const IMAGE_TYPES = [
        ".GIF", 
        ".HEIC",
        ".JPG",
        ".JPEG", 
        ".PNG",
        ".NEF"
    ];
    return IMAGE_TYPES;
}
function getKnownTypes(): string[] {
    const KNOWN_TYPES = [
        ... getVideoTypes(),
        ... getImageTypes(),
    ];
    return KNOWN_TYPES;
}
export function isKnownType(filename: string): boolean {
    return getKnownTypes().includes(path.extname(filename).toUpperCase());
}
export function isVideo(filename: string): boolean {
    return getVideoTypes().includes(path.extname(filename).toUpperCase());
}
