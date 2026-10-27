const ALLOWED_ORIGIN = "https://football2024pl-ai.github.io";
const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";

const MAX_MESSAGES = 26;
const MAX_TOTAL_CHARS = 150000;
const LOCAL_LIMIT = 8;
const LOCAL_WINDOW_MS = 60000;

const localBuckets = new Map();

function headersFor(origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  };

  if (origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }

  return headers;
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: headersFor(origin)
  });
}

function localLimit(key) {
  const now = Date.now();
  const previous = localBuckets.get(key);

  if (!previous || now - previous.start >= LOCAL_WINDOW_MS) {
    localBuckets.set(key, { start: now, count: 1 });

    if (localBuckets.size > 2000) {
      for (const [bucketKey, bucket] of localBuckets) {
        if (now - bucket.start >= LOCAL_WINDOW_MS) {
          localBuckets.delete(bucketKey);
        }
      }
    }

    return true;
  }

  if (previous.count >= LOCAL_LIMIT) return false;

  previous.count++;
  return true;
}

function contentToText(content) {
  if (typeof content === "string") return content.trim();

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;

        return part && typeof part.text === "string"
          ? part.text
          : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return "";
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (origin !== ALLOWED_ORIGIN) {
      return json(
        { ok: false, error: "Недопустимый источник запроса." },
        403,
        origin
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: headersFor(origin)
      });
    }

    if (request.method !== "POST") {
      return json(
        { ok: false, error: "Используй POST-запрос." },
        405,
        origin
      );
    }

    if (url.pathname !== "/chat") {
      return json(
        { ok: false, error: "Маршрут не найден. Используй /chat." },
        404,
        origin
      );
    }

    if (!env.OPENROUTER_API_KEY) {
      return json(
        {
          ok: false,
          error: "Не настроен секрет OPENROUTER_API_KEY в Cloudflare."
        },
        503,
        origin
      );
    }

    const ip =
      request.headers.get("CF-Connecting-IP") || "unknown";

    try {
      if (env.CHAT_RATE_LIMITER) {
        const result =
          await env.CHAT_RATE_LIMITER.limit({ key: ip });

        if (!result.success) {
          return json(
            {
              ok: false,
              error: "Слишком много запросов. Подожди минуту и попробуй снова."
            },
            429,
            origin
          );
        }
      } else if (!localLimit(ip)) {
        return json(
          {
            ok: false,
            error: "Слишком много запросов. Подожди минуту и попробуй снова."
          },
          429,
          origin
        );
      }
    } catch (_) {
      if (env.CHAT_RATE_LIMITER) {
        return json(
          {
            ok: false,
            error: "Не удалось проверить лимит запросов. Попробуй позже."
          },
          503,
          origin
        );
      }
    }

    let body;

    try {
      body = await request.json();
    } catch (_) {
      return json(
        { ok: false, error: "Некорректный JSON." },
        400,
        origin
      );
    }

    if (
      !body ||
      !Array.isArray(body.messages) ||
      body.messages.length === 0
    ) {
      return json(
        { ok: false, error: "В запросе отсутствует messages." },
        400,
        origin
      );
    }

    const messages = body.messages.slice(-MAX_MESSAGES);
    let totalChars = 0;

    for (const message of messages) {
      if (
        !message ||
        !["system", "user", "assistant"].includes(message.role) ||
        typeof message.content !== "string"
      ) {
        return json(
          { ok: false, error: "Неподдерживаемый формат сообщения." },
          400,
          origin
        );
      }

      if (message.content.length > 50000) {
        return json(
          {
            ok: false,
            error: "Одно сообщение слишком длинное: максимум 50 000 символов."
          },
          413,
          origin
        );
      }

      totalChars += message.content.length;
    }

    if (totalChars > MAX_TOTAL_CHARS) {
      return json(
        {
          ok: false,
          error: "История слишком большая. Сократи её и попробуй снова."
        },
        413,
        origin
      );
    }

    let upstream;

    try {
      upstream = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer":
            "https://football2024pl-ai.github.io/opus-55-chat/",
          "X-Title": "Opus 55 Chat"
        },
        body: JSON.stringify({
          // Только бесплатный маршрутизатор.
          model: "openrouter/free",
          messages,
          max_tokens: 3000,
          temperature: 0.35
        })
      });
    } catch (_) {
      return json(
        {
          ok: false,
          error: "Не удалось связаться с OpenRouter. Попробуй позже."
        },
        502,
        origin
      );
    }

    let data;

    try {
      data = await upstream.json();
    } catch (_) {
      return json(
        {
          ok: false,
          error: "OpenRouter вернул ответ в неизвестном формате."
        },
        502,
        origin
      );
    }

    if (!upstream.ok) {
      if (upstream.status === 429) {
        return json(
          {
            ok: false,
            error: "У бесплатных моделей OpenRouter сейчас лимит. Попробуй позже."
          },
          429,
          origin
        );
      }

      if (upstream.status === 401 || upstream.status === 403) {
        return json(
          {
            ok: false,
            error: "OpenRouter не принял ключ. Проверь секрет в Cloudflare."
          },
          502,
          origin
        );
      }

      return json(
        {
          ok: false,
          error: "OpenRouter не смог обработать запрос: HTTP " +
            upstream.status
        },
        502,
        origin
      );
    }

    const choice =
      data && Array.isArray(data.choices)
        ? data.choices[0]
        : null;

    const answer =
      choice && choice.message
        ? contentToText(choice.message.content)
        : "";

    if (!answer) {
      return json(
        {
          ok: false,
          error: "OpenRouter не вернул текст. Попробуй снова."
        },
        502,
        origin
      );
    }

    return json({
      ok: true,
      answer,
      model: typeof data.model === "string"
        ? data.model
        : "openrouter/free",
      provider: "OpenRouter"
    }, 200, origin);
  }
};
