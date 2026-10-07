import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Banner,
  EmptyState,
  EventCard,
  PageHeader,
  SegmentedControl,
  Skeleton,
  TextField,
} from "../components";
import { useEventList } from "../hooks/events";
import { useContracts } from "../hooks";

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "settling", label: "Settling" },
  { value: "settled", label: "Settled" },
  { value: "disputed", label: "Disputed" },
];

/** Events marketplace. Filters live in the URL so a view can be shared. */
export function Marketplace() {
  const nav = useNavigate();
  const { deployment } = useContracts();
  const { events, error, loading } = useEventList();
  const [params, setParams] = useSearchParams();
  const kind = params.get("kind") ?? "all";
  const status = params.get("status") ?? "all";
  const q = params.get("q") ?? "";
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "" || value === "all") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const shown = (events ?? [])
    .filter((e) => kind === "all" || e.kind === kind)
    .filter((e) => {
      if (status === "all") return true;
      if (status === "open") return e.status === "open";
      if (status === "settling") return ["cutoff", "awaiting", "settling"].includes(e.status);
      return e.status === status;
    })
    .filter((e) => !q || `${e.label} ${e.key}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.id - a.id);

  return (
    <>
      <PageHeader
        eyebrow="Cover"
        title="Events"
        subtitle="Insurable flights and weather cells. Pick one to buy cover or follow its settlement."
      />
      <div className="ties-row" style={{ alignItems: "flex-end", gap: 16 }}>
        <SegmentedControl
          label="Category"
          value={kind}
          onChange={(v) => set("kind", v)}
          options={[
            { value: "all", label: "All" },
            { value: "flight", label: "Flight", icon: "plane" },
            { value: "weather", label: "Weather", icon: "rain" },
          ]}
        />
        <SegmentedControl
          label="Status"
          value={status}
          onChange={(v) => set("status", v)}
          options={STATUS_FILTERS}
        />
        <TextField
          label="Search"
          value={q}
          placeholder="Flight, place or date"
          onChange={(v) => set("q", v)}
          style={{ width: 260 }}
        />
      </div>
      {error ? (
        <Banner tone="danger" title="Could not read events">
          {error}
        </Banner>
      ) : null}
      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 16 }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="ties-card">
              <Skeleton w="40%" />
              <Skeleton h={20} />
              <Skeleton w="70%" />
              <Skeleton h={40} />
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          title="No events match these filters"
          body={
            deployment
              ? "Change the filters, or ask the admin to create an event."
              : "Nothing is deployed on this network yet."
          }
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
            gap: 16,
          }}
        >
          {shown.map((e) => (
            <EventCard
              key={e.id}
              event={{
                id: e.id,
                name: e.label,
                kind: e.kind,
                metric:
                  e.kind === "flight"
                    ? "Arrival delay, minutes · pays if delay ≥ threshold"
                    : "Rainfall 24 h, mm · pays if rainfall ≥ threshold",
                window: e.windowText,
                cutoff: e.cutoffText,
                status: e.status,
                statusLabel: e.statusLabel,
                bound: Number(e.locked) / 1e18,
                policies: e.policies,
                capacity: e.capacity,
                capacityLeft: e.capacityLeft,
              }}
              onBuy={() => nav(`/buy/${e.id}`)}
              onView={() => nav(`/explorer/${e.id}`)}
            />
          ))}
        </div>
      )}
    </>
  );
}
