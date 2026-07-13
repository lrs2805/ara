/**
 * Minimal Daily REST helpers (meeting tokens).
 * Docs: https://docs.daily.co/reference/rest-api/meeting-tokens
 */

export async function createMeetingToken(options: {
  apiKey: string;
  roomUrl: string;
  userName: string;
}): Promise<string> {
  const roomName = new URL(options.roomUrl).pathname.replace(/^\//, "");
  if (!roomName) {
    throw new Error(`Invalid Daily room URL: ${options.roomUrl}`);
  }

  const res = await fetch("https://api.daily.co/v1/meeting-tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        room_name: roomName,
        user_name: options.userName,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Daily meeting-token failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { token: string };
  return data.token;
}
