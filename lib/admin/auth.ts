import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE_NAME } from "../constants";

/** Checked in every /api/admin/* route handler (except /api/admin/login itself). */
export function isAdminRequestAuthorized(req: NextRequest): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false; // never allow admin access if no password is configured
  return req.cookies.get(ADMIN_COOKIE_NAME)?.value === expected;
}

/** Checked from the /admin Server Component to decide whether to render the login form or the dashboard. */
export async function isAdminAuthorizedServer(): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const store = await cookies();
  return store.get(ADMIN_COOKIE_NAME)?.value === expected;
}
