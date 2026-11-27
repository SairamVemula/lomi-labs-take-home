import Link from "next/link";
import { linkClass } from "../lib/focus";

export function LlmBanner({ waiting }: { waiting: number }) {
  return (
    <div role="status" className="flex flex-col gap-1 rounded-md bg-pending/15 px-4 py-3">
      <strong className="text-pending font-semibold">No LLM configured</strong>
      <span className="text-label text-ink">
        {waiting > 0
          ? `${waiting} ${waiting === 1 ? "document is" : "documents are"} waiting. `
          : ""}
        Add a model in{" "}
        <Link href="/settings" className={linkClass}>
          settings
        </Link>{" "}
        and they&rsquo;ll be extracted automatically.
      </span>
    </div>
  );
}
