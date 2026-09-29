import { createApi } from "@teb-ooo/web";
import type { paths } from "./schema";

/**
 * The app's typed API client and Query hooks: `api.useQuery("get", "/api/items")`. Never call `fetch` directly.
 * The base URL is the page origin (the library default); a relative "/" base does not work under jsdom.
 */
export const api = createApi<paths>();
