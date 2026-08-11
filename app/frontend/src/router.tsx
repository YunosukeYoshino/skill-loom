import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router"
import {
  DraftsPage,
  ExternalPreviewPage,
  ExternalSourceDetailPage,
  ExternalSourcesPage,
  GlobalPage,
  ProjectDeckPage,
} from "@/pages"

const rootRoute = createRootRoute({
  component: () => <Outlet />,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/global" })
  },
})

const globalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/global",
  validateSearch: (search: Record<string, unknown>): { catalog?: boolean } => ({
    catalog: search.catalog === true || search.catalog === "1" || search.catalog === 1 ? true : undefined,
  }),
  component: function GlobalRoute() {
    const { catalog } = globalRoute.useSearch()
    return <GlobalPage catalog={!!catalog} />
  },
})

const externalSourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/external-sources",
  component: ExternalSourcesPage,
})

const externalSourceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/external-sources/$source",
  component: function ExternalSourceDetailRoute() {
    const { source } = externalSourceDetailRoute.useParams()
    return <ExternalSourceDetailPage source={source} />
  },
})

const draftsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/drafts",
  component: DraftsPage,
})

const projectDeckRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/project-decks/$deckName",
  validateSearch: (search: Record<string, unknown>): { catalog?: boolean } => ({
    catalog: search.catalog === true || search.catalog === "1" || search.catalog === 1 ? true : undefined,
  }),
  component: function ProjectDeckRoute() {
    const { deckName } = projectDeckRoute.useParams()
    const { catalog } = projectDeckRoute.useSearch()
    return <ProjectDeckPage deckName={deckName} catalog={!!catalog} />
  },
})

const externalPreviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/external-preview",
  validateSearch: (search: Record<string, unknown>) => ({
    source: typeof search.source === "string" ? search.source : "",
    deck: typeof search.deck === "string" ? search.deck : "",
  }),
  component: function ExternalPreviewRoute() {
    const { source, deck } = externalPreviewRoute.useSearch()
    return <ExternalPreviewPage source={source} deck={deck} />
  },
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  globalRoute,
  externalSourcesRoute,
  externalSourceDetailRoute,
  draftsRoute,
  projectDeckRoute,
  externalPreviewRoute,
])

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
