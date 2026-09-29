import { useRef } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useRegisterCommands } from "@teb-ooo/cmdk";
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
  // closes, so the focus move waits one frame to win.
  const nameInput = useRef<HTMLInputElement>(null);
  useRegisterCommands([
    {
      id: "create-item",
      title: "New item",
      group: "Items",
      keywords: ["add", "create", "item", "name"],
      icon: Plus,
      run: () => {
        requestAnimationFrame(() => {
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
      <h1 className="text-xl text-ink">Items</h1>

      <form onSubmit={form.handleSubmit} className="flex flex-col gap-3" noValidate>
        <Field label="Name" error={name.error} description="What to call the new item.">
          <Input ref={nameInput} value={name.value} onChange={(e) => name.onChange(e.target.value)} onBlur={name.onBlur} autoComplete="off" />
        </Field>
        <div>
          <Button type="submit" intent="solid" loading={form.isSubmitting}>
            <Plus aria-hidden size={16} />
            Add item
          </Button>
        </div>
        {submitProblem ? <p role="alert" className="text-sm text-danger">The item could not be saved. {describeError(submitProblem)}</p> : null}
      </form>

      {items.isPending ? (
        <p className="text-sm text-muted">Loading items.</p>
      ) : items.error ? (
        <p role="alert" className="text-sm text-danger">The items could not be loaded. {describeError(items.error)}</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted">There are no items yet. Add the first one with the form above.</p>
      ) : (
        <ul className="flex flex-col">
          {list.map((item) => (
            <li key={item.id} className="flex items-baseline justify-between gap-4 border-b border-line py-2">
              <span className="text-base text-ink">{item.name}</span>
              <span className="text-sm text-muted">{fmtRelative(item.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
