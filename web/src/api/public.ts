import type { PublicLettersResponse } from "./types";

export async function fetchPublicLetters(): Promise<PublicLettersResponse> {
  const res = await fetch("/api/public/letters");
  if (!res.ok) {
    throw new Error(`GET /api/public/letters ${res.status}`);
  }
  return (await res.json()) as PublicLettersResponse;
}
