import { z } from 'zod';

const organizationAgentSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1).nullable(),
});

/** Registration and organization enrollment are separate facts; never infer membership. */
export function organizationEnrollmentReceipt(agent: unknown, webBase: string): string {
  const { id, orgId } = organizationAgentSchema.parse(agent);
  if (orgId !== null) return `Organization enrollment: confirmed\n  organization: ${orgId}`;
  const url = new URL(`/chat/agents/${encodeURIComponent(id)}/organization`, webBase);
  return 'Organization enrollment: pending confirmation\n' +
    '  Ask the owner to sign in and confirm their current organization:\n' +
    `  ${url.href}\n` +
    '  This agent will not appear in the Warden organization directory until confirmed.\n' +
    '  Do not approve on the owner\'s behalf or send orgId directly to registration.';
}
