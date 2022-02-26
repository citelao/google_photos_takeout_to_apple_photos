import fs from "fs";

interface Timestamp {
    timestamp: string;
    formatted: string;
}
interface GeoData {
    latitude: number;
    longitude: number;
    altitude: number;
    latitudeSpan: number;
    longitudeSpan: number;
}
export interface AlbumMetadataJson {
    title: string;
    description: string;
    access: string;
    date: Timestamp,
    location: string;
    geoData: GeoData;
}
export function parseAlbumMetadataJson(metadataJsonPath: string): AlbumMetadataJson {
    const json = JSON.parse(fs.readFileSync(metadataJsonPath).toString('utf-8'));
    return json as AlbumMetadataJson;
}

export interface ImageMetadataJson {
    title: string;
    description: string;
    imageViews: string;
    creationTime: Timestamp;
    photoTakenTime: Timestamp;
    geoData: GeoData;
    geoDataExif: GeoData;
    url: string;
    googlePhotosOrigin: {
        mobileUpload: {
            deviceType: "IOS_PHONE" | string;
        }
    } | unknown;
    photoLastModifiedTime: Timestamp;
}
export function parseImageMetadataJson(jsonPath: string): ImageMetadataJson {
    const json = JSON.parse(fs.readFileSync(jsonPath).toString('utf-8'));
    return json as ImageMetadataJson;
}
