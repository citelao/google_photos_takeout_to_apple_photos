import Logger from "./Logger";

export function toFixed(n: number | string, digits: number): number {
    if (typeof n === "string") {
        n = Number.parseFloat(n);
    }
    return Math.round((n + Number.EPSILON) * Math.pow(10, digits)) / Math.pow(10, digits);
}

export function distance(a: { lat: number; lon: number; }, b: { lat: number; lon: number; }): number {
    // Logger.log(a, b);
    return Math.sqrt(Math.pow(a.lat - b.lat, 2) + Math.pow(a.lon - b.lon, 2));
}
