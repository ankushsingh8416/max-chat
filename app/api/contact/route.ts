import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { CONTACT_RATE_LIMIT_MAX, CONTACT_RATE_LIMIT_WINDOW_MS } from "@/lib/constants";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ContactPayload {
  name: string;
  email: string;
  phone: string;
  message: string;
}

function sanitize(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  const rateLimit = checkRateLimit(`contact:${ip}`, {
    max: CONTACT_RATE_LIMIT_MAX,
    windowMs: CONTACT_RATE_LIMIT_WINDOW_MS,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many submissions. Please try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } }
    );
  }

  let body: Partial<ContactPayload>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const name = sanitize(body.name, 100);
  const email = sanitize(body.email, 200);
  const phone = sanitize(body.phone, 20);
  const message = sanitize(body.message, 2000);

  if (!name || !email || !phone || !message) {
    return NextResponse.json({ error: "Name, email, phone, and message are all required." }, { status: 400 });
  }
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
  }

  // TODO: persist to a Supabase `leads` table and/or send an email/CRM
  // notification once that's set up. For now this just logs server-side so
  // submissions are visible while the form is being tested.
  console.log("[contact] New lead:", {
    name,
    email,
    phone,
    message,
    ip,
    receivedAt: new Date().toISOString(),
  });

  return NextResponse.json({ success: true });
}
