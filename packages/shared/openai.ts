export async function sayHelloWithOpenAI(): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: "Say hello",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenAI request failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`,
    );
  }

  const data: any = await res.json();

  if (typeof data?.output_text === "string" && data.output_text.length > 0) {
    return data.output_text;
  }

  const fallbackText = (data?.output ?? [])
    .flatMap((item: any) => item?.content ?? [])
    .map((c: any) => c?.text)
    .filter((t: unknown) => typeof t === "string" && t.length > 0)
    .join("\n")
    .trim();

  if (fallbackText) return fallbackText;

  throw new Error("OpenAI response did not include text output");
}

