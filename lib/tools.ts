import { tool } from "ai";
import { z } from "zod";

/**
 * Lets the model itself decide when a conversation needs human follow-up —
 * the user wants deeper/personalized detail than the knowledge base can give
 * (site visit, exact pricing, negotiation), or explicitly asks to get in
 * touch/request a callback — rather than the client guessing from fixed text
 * patterns in the bot's reply. The client (components/ChatWidget.tsx) watches
 * for this tool call in the message stream and opens the contact form
 * immediately when it appears.
 *
 * `execute` is trivial and always succeeds instantly — this tool's purpose is
 * the call itself as a UI signal, not any real server-side action.
 */
export const suggestContactFormTool = tool({
  description:
    "Call this when the user wants to get in touch, requests a callback, asks for contact details, or clearly wants more detailed or personalized help (e.g. a site visit, exact pricing, negotiation, document requests) than the knowledge base context can provide. This immediately shows the user a contact form (name, email, phone, message) to leave their details. After calling it, briefly and warmly tell the user you're bringing up a form for them to share their details.",
  inputSchema: z.object({
    reason: z.string().describe("A short reason this was triggered, for logging only (not shown to the user)."),
  }),
  execute: async ({ reason }) => {
    console.log(`[tools] suggestContactForm triggered: ${reason}`);
    return { formShown: true };
  },
});
