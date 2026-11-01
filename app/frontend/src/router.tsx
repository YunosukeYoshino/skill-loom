import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import {
  DraftsPage,
  ExternalPreviewPage,
  ExternalSourceDetailPage,
  ExternalSourcesPage,
  GlobalPage,
  ProjectDeckPage,
  SettingsPage,
} from "@/pages";
import { PageError } from "@/components/ui";
import { useT } from "@/settings/react";
import { validateListViewSearch } from "./router-search";
import { SkillWorkspacePage } from "@/pages/skill-workspace";

function navCurrentFromPath(pathname: string): string {
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/drafts")) return "drafts";
  if (pathname.startsWith("/external-sources")) return "external-sources";
  if (pathname.startsWith("/project-decks/")) {
    return `project:${pathname.split("/")[2] || ""}`;
  }
  return "global";
}

function RouteError({ error }: { error: Error }) {
  const t = useT();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <PageError
      current={navCurrentFromPath(pathname)}
      title={t("error.routeTitle")}
      message={error.message || t("error.fallback")}
    />
  );
}

function RouteNotFound() {
  const t = useT();
  return (
    <PageError
      current="global"
      title={t("error.notFound")}
      message={t("error.notFoundMessage")}
    />
  );
}

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  errorComponent: RouteError,
  notFoundComponent: RouteNotFound,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/global" });
  },
});

const globalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/global",
  validateSearch: validateListViewSearch,
  component: function GlobalRoute() {
    const { catalog } = globalRoute.useSearch();
    return <GlobalPage catalog={!!catalog} />;
  },
});

const externalSourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/external-sources",
  validateSearch: validateListViewSearch,
  component: ExternalSourcesPage,
});

const externalSourceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/external-sources/$source",
  component: function ExternalSourceDetailRoute() {
    const { source } = externalSourceDetailRoute.useParams();
    return <ExternalSourceDetailPage source={source} />;
  },
});

const draftsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/drafts",
  validateSearch: validateListViewSearch,
  component: DraftsPage,
});

const skillRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/skills/$name",
  validateSearch: (search: Record<string, unknown>) => ({
    source: typeof search.source === "string" ? search.source : undefined,
    skillPath:
      typeof search.skillPath === "string" ? search.skillPath : undefined,
    prompt: typeof search.prompt === "string" ? search.prompt : undefined,
  }),
  component: function SkillRoute() {
    const { name } = skillRoute.useParams();
    const search = skillRoute.useSearch();
    return (
      <SkillWorkspacePage
        key={JSON.stringify([name, search.source, search.skillPath])}
        name={name}
        {...search}
      />
    );
  },
});

const projectDeckRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/project-decks/$deckName",
  validateSearch: validateListViewSearch,
  component: function ProjectDeckRoute() {
    const { deckName } = projectDeckRoute.useParams();
    const { catalog } = projectDeckRoute.useSearch();
    return <ProjectDeckPage deckName={deckName} catalog={!!catalog} />;
  },
});

const externalPreviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/external-preview",
  validateSearch: (search: Record<string, unknown>) => ({
    source: typeof search.source === "string" ? search.source : "",
    deck: typeof search.deck === "string" ? search.deck : "",
  }),
  component: function ExternalPreviewRoute() {
    const { source, deck } = externalPreviewRoute.useSearch();
    return <ExternalPreviewPage source={source} deck={deck} />;
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  globalRoute,
  externalSourcesRoute,
  externalSourceDetailRoute,
  draftsRoute,
  skillRoute,
  projectDeckRoute,
  externalPreviewRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
