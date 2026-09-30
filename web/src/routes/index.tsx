import { useRef } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useRegisterCommands } from "@teb-ooo/ui/cmdk";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Field, Input } from "@teb-ooo/ui";
import { RequireUser, createBodyValidator, fmtRelative, isApiError, useForm } from "@teb-ooo/web";
import type { OpenApiDocument } from "@teb-ooo/web";
import { Plus } from "lucide-react";
import spec from "../../openapi.json";
import { api } from "../api";
import { describeError } from "../api/describe-error";

export const Route = createFileRoute("/")({
  staticData: { title: "Items" },
  beforeLoad: RequireUser,
  component: ItemsPage,
});

const validator = createBodyValidator<{ name: string }>(spec as OpenApiDocument, "create-item");

function ItemsPage() {
  const queryClient = useQueryClient();
  const items = api.useQuery("get", "/api/items");
  const create = api.useMutation("post", "/api/items", {
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["get", "/api/items"] }),
  });

  const form = useForm(validator, {
    defaultValues: { name: "" },
    onSubmit: async (body) => {
      await create.mutateAsync({ body });
      form.reset();
    },
  });
  const name = form.field<string>("name");

  // Every user action has a command (BOOTSTRAP 9.7c). The palette returns focus to the element that had it when it
  // closes, so the focus move goes through ctx.afterClose to win.
  const nameInput = useRef<HTMLInputElement>(null);
  useRegisterCommands([
    {
      id: "create-item",
      title: "New item",
      group: "Items",
      keywords: ["add", "create", "item", "name"],
      icon: Plus,
      run: (ctx) => {
        ctx.afterClose(() => {
          nameInput.current?.scrollIntoView?.({ block: "center" });
          nameInput.current?.focus();
        });
      },
    },
  ]);
  // A server error that is not about the name field (for example a 500) is shown as a sentence under the form.
  const list = items.data?.items ?? [];
  const submitProblem = create.error && !(isApiError(create.error) && create.error.fieldErrors["body.name"]) ? create.error : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="display-lg text-ink">Items</h1>

      <form onSubmit={form.handleSubmit} className="panel flex flex-col gap-3 p-4" noValidate>
        <Field label="Name" error={name.error} description="What to call the new item.">
          <Input ref={nameInput} value={name.value} onChange={(e) => name.onChange(e.target.value)} onBlur={name.onBlur} autoComplete="off" />
        </Field>
        <div>
          <Button type="submit" intent="solid" icon={<Plus aria-hidden size={16} />} loading={form.isSubmitting}>
            Add item
          </Button>
        </div>
        {submitProblem ? <p role="alert" className="text-danger">The item could not be saved. {describeError(submitProblem)}</p> : null}
      </form>

      {items.isPending ? (
        <p className="text-ink-muted">Loading items.</p>
      ) : items.error ? (
        <p role="alert" className="text-danger">The items could not be loaded. {describeError(items.error)}</p>
      ) : list.length === 0 ? (
        <div className="flex flex-col gap-2 py-6">
          <p className="display-lg text-ink">No items yet</p>
          <p className="text-ink-muted">Add the first one with the form above.</p>
        </div>
      ) : (
        <ul className="panel flex flex-col">
          {list.map((item) => (
            <li key={item.id} className="flex items-baseline justify-between gap-4 border-b border-line px-4 py-2 last:border-b-0">
              <span className="text-ink">{item.name}</span>
              <span className="text-ink-faint">{fmtRelative(item.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
