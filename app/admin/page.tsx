import { isAdminAuthorizedServer } from "@/lib/admin/auth";
import { AdminLoginForm } from "@/components/admin/AdminLoginForm";
import { UploadDashboard } from "@/components/admin/UploadDashboard";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const authorized = await isAdminAuthorizedServer();

  return (
    <main className="min-h-screen bg-me-neutral-50 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-1 text-2xl font-semibold text-me-neutral-900">Train the assistant</h1>
        <p className="mb-6 text-sm text-me-neutral-800">
          Upload documents (PDF, Word, or plain text) to add them to the chatbot&apos;s knowledge base.
        </p>
        {authorized ? <UploadDashboard /> : <AdminLoginForm />}
      </div>
    </main>
  );
}
