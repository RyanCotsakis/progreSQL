import { Login } from "./components/Login";
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
  Dumbbell,
  History,
  LayoutGrid,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  Search,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Card, Field, Input, Select, Textarea } from "@/components/ui/fields";
import { cn } from "@/lib/utils";
import {
  localDay,
  membersFor,
  primaryKeys,
  stateFor,
  tableColumns,
  tableNames,
  type AppData,
  type Exercise,
  type Prescription,
  type TableName,
  type Workout,
  type WorkoutSession,
} from "../shared/model";
import type { Action } from "../shared/actions";

type Run = (action: Action, message?: string) => Promise<boolean>;
type Page = "journal" | "library" | "history" | "admin";
type Modal = { type: "exercise" | "workout" | "session"; id?: number } | null;
const fmt = (
  day: string,
  options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
  },
) => new Date(day + "T12:00:00").toLocaleDateString("en-GB", options);
const form = (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  return new FormData(event.currentTarget);
};
const str = (data: FormData, key: string) => String(data.get(key) || "");
const num = (data: FormData, key: string) => Number(data.get(key));
const stateFields = (data: FormData) => ({
  effective_from: str(data, "effective_from"),
  weight: num(data, "weight"),
  max_reps: num(data, "max_reps"),
  sets: num(data, "sets"),
  notes: str(data, "notes"),
});

class AuthenticationRequired extends Error {
  constructor() {
    super("Please sign in to open your journal.");
  }
}
async function getData(): Promise<AppData> {
  const response = await fetch("/api/data");
  if (response.status === 401) throw new AuthenticationRequired();
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Please sign in to open your private journal."
        : "Could not load your journal. Check your connection and try again.",
    );
  return response.json();
}

export default function App() {
  const [data, setData] = useState<AppData>();
  const [page, setPage] = useState<Page>("journal");
  const [modal, setModal] = useState<Modal>(null);
  const [day, setDay] = useState(localDay());
  const [workoutId, setWorkoutId] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await getData());
    } catch (e) {
      if (e instanceof AuthenticationRequired) {
        setData(undefined);
        setModal(null);
      }
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  const run: Run = async (action, message = "Changes saved.") => {
    if (saving) return false;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
      });
      if (response.status === 401) {
        setData(undefined);
        setModal(null);
        throw new AuthenticationRequired();
      }
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Could not save changes.");
      }
      try {
        setData(await getData());
        setNotice(message);
      } catch {
        setError(
          "Your changes were saved, but the view could not refresh. Reload before making more changes.",
        );
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  async function signOut() {
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("Could not sign out.");
      setData(undefined);
      setModal(null);
      setError("");
      setNotice("");
    } catch {
      setError("Could not sign out. Please try again.");
    }
  }
  useEffect(() => {
    if (!data) return;
    const check = async () => {
      try {
        const response = await fetch("/api/auth/session");
        if (response.status === 401) {
          setData(undefined);
          setModal(null);
        }
      } catch {
        /* The next API call will retry authentication. */
      }
    };
    const timer = setInterval(() => void check(), 60000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [!!data]);
  if (!data)
    return <Login loading={loading} onSuccess={refresh} initialError={error} />;
  const nav = [
    { id: "journal" as const, icon: CalendarDays, label: "Workout journal" },
    { id: "library" as const, icon: LayoutGrid, label: "My library" },
    { id: "history" as const, icon: History, label: "Session history" },
    { id: "admin" as const, icon: Database, label: "Data manager" },
  ];
  const activeWorkouts = data?.workouts.filter((w) => w.is_active) || [];
  const selectedId = activeWorkouts.some((w) => w.workout_id === workoutId)
    ? workoutId
    : activeWorkouts[0]?.workout_id || 0;
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_1fr]">
      <aside className="border-b bg-white lg:fixed lg:inset-y-0 lg:w-[232px] lg:border-r lg:border-b-0">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("journal");
          }}
          className="flex items-center gap-3 px-5 py-6 lg:px-7 lg:py-9"
        >
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-white">
            <Dumbbell size={21} />
          </span>
          <span className="text-xl font-semibold tracking-tight">
            ProgreSQL<span className="text-primary">.</span>
          </span>
        </a>
        <p className="eyebrow mb-3 hidden px-7 lg:block">Navigation</p>
        <nav
          aria-label="Main navigation"
          className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:px-4"
        >
          {nav.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => setPage(id)}
              aria-current={page === id ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-3 rounded-lg px-3 py-3 text-sm transition-colors",
                page === id
                  ? "bg-primary/8 font-semibold text-primary"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="absolute bottom-6 hidden w-full px-5 lg:block">
          <a
            href="#"
            onClick={(event) => {
              event.preventDefault();
              void signOut();
            }}
            className="mt-5 flex items-center gap-2 px-2 text-xs text-muted-foreground"
          >
            <LogOut size={15} /> Sign out
          </a>
        </div>
      </aside>
      <div className="min-w-0 lg:col-start-2">
        <header className="flex h-16 items-center justify-between border-b px-5 sm:px-10">
          <span className="text-sm text-foreground">
            {nav.find((n) => n.id === page)?.label}
          </span>
          <span className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            <span className="size-1.5 rounded-full bg-primary" />
            {fmt(localDay(), {
              weekday: "short",
              day: "numeric",
              month: "short",
            })}
          </span>
          <a
            href="#"
            onClick={(event) => {
              event.preventDefault();
              void signOut();
            }}
            aria-label="Sign out"
            className="lg:hidden"
          >
            <LogOut size={17} />
          </a>
        </header>
        <main className="mx-auto max-w-[1300px] px-5 py-8 sm:px-10 sm:py-10">
          {
            <>
              {page === "journal" && (
                <Journal
                  data={data}
                  day={day}
                  setDay={setDay}
                  workoutId={selectedId}
                  setWorkoutId={setWorkoutId}
                  run={run}
                  saving={saving}
                  open={setModal}
                />
              )}
              {page === "library" && (
                <Library
                  data={data}
                  open={setModal}
                  log={(id) => {
                    setWorkoutId(id);
                    setPage("journal");
                  }}
                />
              )}
              {page === "history" && (
                <HistoryPage data={data} open={setModal} />
              )}
              {page === "admin" && (
                <Admin data={data} run={run} saving={saving} />
              )}
            </>
          }
        </main>
        <footer className="mx-auto flex max-w-[1300px] justify-between px-5 py-6 text-xs text-muted-foreground sm:px-10">
          <span>ProgreSQL · 2.0.2</span>
        </footer>
      </div>
      {((error && data) || notice) && (
        <div
          role={error ? "alert" : "status"}
          className={cn(
            "fixed bottom-5 left-5 right-5 z-[60] mx-auto flex max-w-xl items-center justify-between gap-4 rounded-xl border bg-white p-4 text-sm shadow-lg",
            error ? "border-destructive/30 text-destructive" : "text-primary",
          )}
        >
          <span>{error || notice}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            Dismiss
          </Button>
        </div>
      )}
      {data && modal && (
        <Dialog
          open
          title={
            modal.type === "exercise"
              ? modal.id
                ? "Exercise details"
                : "New exercise"
              : modal.type === "workout"
                ? modal.id
                  ? "Edit workout"
                  : "New workout"
                : "Session details"
          }
          description={
            modal.type === "session"
              ? "View this session's exercises, prescriptions, and notes."
              : undefined
          }
          onClose={() => {
            if (!saving) setModal(null);
          }}
        >
          {modal.type === "exercise" && (
            <ExerciseEditor
              key={modal.id || "new"}
              data={data}
              exercise={data.exercises.find((e) => e.exercise_id === modal.id)}
              run={run}
              saving={saving}
              close={() => setModal(null)}
            />
          )}
          {modal.type === "workout" && (
            <WorkoutEditor
              key={modal.id || "new"}
              data={data}
              workout={data.workouts.find((w) => w.workout_id === modal.id)}
              run={run}
              saving={saving}
              close={() => setModal(null)}
            />
          )}
          {modal.type === "session" && (
            <SessionDetail
              data={data}
              id={modal.id!}
              run={run}
              saving={saving}
              close={() => setModal(null)}
            />
          )}
        </Dialog>
      )}
    </div>
  );
}

function Heading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="eyebrow mb-3">{eyebrow}</p>
        <h1 className="page-title">{title}</h1>
        <p className="mt-3 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed p-6 text-center text-sm leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}
function PrescriptionTable({
  data,
  workoutId,
  day,
}: {
  data: AppData;
  workoutId: number;
  day: string;
}) {
  const members = membersFor(data, workoutId, day);
  if (!members.length)
    return (
      <Empty>
        No exercises scheduled for this date. Add them in your workout’s editor.
      </Empty>
    );
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Exercise</th>
            <th>Weight</th>
            <th>Max reps</th>
            <th>Sets</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m, i) => {
            const exercise = data.exercises.find(
              (e) => e.exercise_id === m.exercise_id,
            );
            const state = stateFor(data, m.exercise_id, day);
            return (
              <tr key={m.workout_exercise_id}>
                <td>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div className="font-medium">
                      {exercise?.exercise_name}
                      <p className="mt-1 text-xs font-normal text-muted-foreground">
                        {exercise?.equipment}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="whitespace-nowrap">
                  {state ? `${state.weight} kg` : "Not set"}
                </td>
                <td>{state?.max_reps ?? "—"}</td>
                <td>{state?.sets ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function Calendar({
  data,
  day,
  setDay,
}: {
  data: AppData;
  day: string;
  setDay: (day: string) => void;
}) {
  const [month, setMonth] = useState(day.slice(0, 7));
  useEffect(() => setMonth(day.slice(0, 7)), [day]);
  const start = new Date(month + "-01T12:00:00");
  const offset = (start.getDay() + 6) % 7;
  const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const logged = new Set(data.sessions.map((s) => s.workout_date));
  const shift = (direction: number) =>
    setMonth(
      localDay(
        new Date(start.getFullYear(), start.getMonth() + direction, 1),
      ).slice(0, 7),
    );
  return (
    <Card>
      <div className="mb-5 flex items-center justify-between">
        <h2 className="font-semibold">
          {start.toLocaleDateString("en-GB", {
            month: "long",
            year: "numeric",
          })}
        </h2>
        <div className="flex">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous month"
            onClick={() => shift(-1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Next month"
            onClick={() => shift(1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={i} className="py-2 text-xs text-muted-foreground">
            {d}
          </span>
        ))}
        {Array.from({ length: offset }, (_, i) => (
          <span key={`empty-${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, "0")}`;
          return (
            <button
              key={date}
              onClick={() => setDay(date)}
              aria-label={`${fmt(date)}${logged.has(date) ? ", workout logged" : ""}`}
              aria-pressed={day === date}
              className={cn(
                "relative flex min-h-11 flex-col items-center justify-center rounded-lg text-sm",
                day === date
                  ? "bg-primary font-medium text-white"
                  : date === localDay()
                    ? "bg-primary/8 font-semibold text-primary"
                    : "hover:bg-muted",
              )}
            >
              <span>{i + 1}</span>
              {logged.has(date) && (
                <span
                  className={cn(
                    "absolute bottom-1 size-1 rounded-full",
                    day === date ? "bg-white" : "bg-primary",
                  )}
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-5 flex items-center justify-between border-t pt-4">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-primary" /> Workout logged
        </span>
        <Button size="sm" variant="ghost" onClick={() => setDay(localDay())}>
          Today
        </Button>
      </div>
    </Card>
  );
}
function Journal({
  data,
  day,
  setDay,
  workoutId,
  setWorkoutId,
  run,
  saving,
  open,
}: {
  data: AppData;
  day: string;
  setDay: (d: string) => void;
  workoutId: number;
  setWorkoutId: (id: number) => void;
  run: Run;
  saving: boolean;
  open: (m: Modal) => void;
}) {
  const active = data.workouts.filter((w) => w.is_active);
  const [notes, setNotes] = useState("");
  const logged = data.sessions.filter((s) => s.workout_date === day);
  const exists = logged.some((s) => s.workout_id === workoutId);
  const today = localDay();
  const startWeek = new Date(today + "T12:00:00");
  startWeek.setDate(startWeek.getDate() - ((startWeek.getDay() + 6) % 7));
  const weekCount = data.sessions.filter(
    (s) => s.workout_date >= localDay(startWeek) && s.workout_date <= today,
  ).length;
  return (
    <>
      <Heading
        eyebrow="Overview"
        title="Your workout journal"
        description="Log workouts and review your sessions."
      />
      <div className="mb-8 grid grid-cols-3 gap-2 sm:gap-4">
        {[
          {
            title: "This week",
            value: weekCount,
            suffix: "sessions logged",
            icon: Activity,
          },
          {
            title: "Total sessions",
            value: data.sessions.length,
            suffix: "sessions logged",
            icon: TrendingUp,
          },
          {
            title: "Your workouts",
            value: active.length,
            suffix: "active workouts",
            icon: Dumbbell,
          },
        ].map((stat) => (
          <Card key={stat.title} className="!p-3 sm:!p-5">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground sm:text-sm">
                {stat.title}
              </p>
              <stat.icon size={17} className="text-primary/65" />
            </div>
            <p className="mt-3 text-3xl font-semibold tracking-tight">
              {stat.value}
            </p>
            <p className="mt-1 hidden text-xs text-muted-foreground sm:block">
              {stat.suffix}
            </p>
          </Card>
        ))}
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="eyebrow mb-2">Your session</p>
              <h2 className="text-xl font-semibold">
                {fmt(day, { weekday: "long", day: "numeric", month: "long" })}
              </h2>
            </div>
            <Input
              aria-label="Workout date"
              type="date"
              value={day}
              onChange={(e) => {
                if (e.target.value) setDay(e.target.value);
              }}
              className="w-auto"
            />
          </div>
          {active.length ? (
            <>
              <label
                htmlFor="workout-select"
                className="mb-2 block text-sm font-medium"
              >
                Choose a workout
              </label>
              <Select
                id="workout-select"
                value={workoutId}
                onChange={(e) => setWorkoutId(Number(e.target.value))}
              >
                {active.map((w) => (
                  <option key={w.workout_id} value={w.workout_id}>
                    {w.workout_name}
                  </option>
                ))}
              </Select>
              <div className="my-5">
                <PrescriptionTable
                  data={data}
                  workoutId={workoutId}
                  day={day}
                />
              </div>
              <label
                htmlFor="session-notes"
                className="mb-2 block text-sm font-medium"
              >
                Session notes{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </label>
              <Textarea
                id="session-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="How did it feel today?"
                maxLength={10000}
              />
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  Prescriptions shown as of {fmt(day)}.
                </span>
                <Button
                  disabled={saving || exists}
                  onClick={async () => {
                    if (
                      await run(
                        {
                          action: "session.log",
                          id: workoutId,
                          workout_date: day,
                          notes,
                        },
                        "Workout logged. Keep showing up!",
                      )
                    )
                      setNotes("");
                  }}
                >
                  {saving ? <Loader2 className="animate-spin" /> : <Check />}
                  {exists ? "Already logged" : "Log workout"}
                </Button>
              </div>
            </>
          ) : (
            <div className="py-8 text-center">
              <Dumbbell size={36} className="mx-auto mb-4 text-primary/50" />
              <h3 className="font-semibold">No workouts available</h3>
              <p className="mx-auto my-3 max-w-sm text-sm text-muted-foreground">
                Create a workout and add exercises before logging a session.
              </p>
              <Button onClick={() => open({ type: "workout" })}>
                <Plus /> Create a workout
              </Button>
            </div>
          )}
        </Card>
        <div className="space-y-6">
          <Calendar data={data} day={day} setDay={setDay} />
          <Card>
            <h2 className="mb-4 font-semibold">Logged on this day</h2>
            {logged.length ? (
              <SessionList data={data} sessions={logged} open={open} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No sessions logged for this date.
              </p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
function Library({
  data,
  open,
  log,
}: {
  data: AppData;
  open: (m: Modal) => void;
  log: (id: number) => void;
}) {
  const [search, setSearch] = useState("");
  const exercises = data.exercises.filter(
    (e) =>
      e.is_active &&
      `${e.exercise_name} ${e.muscle_group || ""} ${e.equipment || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const workouts = data.workouts.filter((w) => w.is_active);
  return (
    <>
      <Heading
        eyebrow="Library"
        title="Your training library"
        description="Manage exercises, workouts, and dated prescriptions."
      >
        <Button onClick={() => open({ type: "workout" })}>
          <Plus /> New workout
        </Button>
      </Heading>
      <div className="mb-10 grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {workouts.map((w) => (
          <Card key={w.workout_id}>
            <div className="flex items-start justify-between">
              <span className="flex size-10 items-center justify-center rounded-xl bg-primary/7 text-primary">
                <Dumbbell size={20} />
              </span>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Edit ${w.workout_name}`}
                onClick={() => open({ type: "workout", id: w.workout_id })}
              >
                <Pencil />
              </Button>
            </div>
            <h2 className="mt-4 text-lg font-semibold">{w.workout_name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {membersFor(data, w.workout_id, localDay()).length} exercises
            </p>
            {w.description && (
              <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
                {w.description}
              </p>
            )}
            <Button
              variant="outline"
              className="mt-5 w-full"
              onClick={() => log(w.workout_id)}
            >
              Log this workout <ChevronRight />
            </Button>
          </Card>
        ))}
        {!workouts.length && (
          <Empty>No workouts yet. Create your first routine above.</Empty>
        )}
      </div>
      <Card>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Exercise library</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Today’s prescriptions. Select an exercise to edit or explore its
              history.
            </p>
          </div>
          <Button variant="outline" onClick={() => open({ type: "exercise" })}>
            <Plus /> New exercise
          </Button>
        </div>
        <div className="relative mb-4 max-w-sm">
          <Search
            size={16}
            className="absolute left-3 top-3 text-muted-foreground"
          />
          <Input
            aria-label="Search exercises"
            placeholder="Search exercises, muscles, equipment…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {exercises.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Exercise</th>
                  <th>Muscle group</th>
                  <th>Weight</th>
                  <th>Max reps × sets</th>
                  <th>
                    <span className="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {exercises.map((e) => {
                  const p = stateFor(data, e.exercise_id, localDay());
                  return (
                    <tr key={e.exercise_id}>
                      <td>
                        <button
                          className="text-left font-medium hover:text-primary hover:underline"
                          onClick={() =>
                            open({ type: "exercise", id: e.exercise_id })
                          }
                        >
                          {e.exercise_name}
                        </button>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {e.equipment || "No equipment specified"}
                        </p>
                      </td>
                      <td>{e.muscle_group || "—"}</td>
                      <td className="whitespace-nowrap">
                        {p ? `${p.weight} kg` : "Not set"}
                      </td>
                      <td>{p ? `${p.max_reps} × ${p.sets}` : "—"}</td>
                      <td>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Edit ${e.exercise_name}`}
                          onClick={() =>
                            open({ type: "exercise", id: e.exercise_id })
                          }
                        >
                          <Pencil />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            {search
              ? "No exercises match your search."
              : "Add your first exercise to start building a workout."}
          </Empty>
        )}
      </Card>
    </>
  );
}
function Save({
  saving,
  children = "Save changes",
}: {
  saving: boolean;
  children?: ReactNode;
}) {
  return (
    <Button type="submit" disabled={saving}>
      {saving ? <Loader2 className="animate-spin" /> : <Check />}
      {children}
    </Button>
  );
}
function StateInputs({ state }: { state?: Prescription }) {
  return (
    <>
      <Field
        label="Effective from"
        name="effective_from"
        type="date"
        required
        defaultValue={localDay()}
      />
      <div className="grid grid-cols-3 gap-3">
        <Field
          label="Weight (kg)"
          name="weight"
          type="number"
          min="0"
          max="99999.99"
          step="2.5"
          required
          defaultValue={state?.weight ?? 0}
        />
        <Field
          label="Max reps"
          name="max_reps"
          type="number"
          min="1"
          step="1"
          required
          defaultValue={state?.max_reps ?? 12}
        />
        <Field
          label="Sets"
          name="sets"
          type="number"
          min="1"
          step="1"
          required
          defaultValue={state?.sets ?? 3}
        />
      </div>
      <Field
        label="Prescription notes (optional)"
        name="notes"
        maxLength={10000}
      />
    </>
  );
}
function Progression({
  history,
  data,
}: {
  history: Prescription[];
  data: AppData;
}) {
  const lastDay = data.sessions[0]?.workout_date;
  const points = history.filter((p) => lastDay && p.effective_from <= lastDay);
  if (!points.length || !lastDay)
    return (
      <p className="text-xs text-muted-foreground">
        Weight progression appears after a workout is logged for this period.
      </p>
    );
  const minTime = Date.parse(points[0].effective_from),
    maxTime = Date.parse(lastDay);
  const maxWeight = Math.max(...points.map((p) => p.weight), 1);
  const x = (d: string) =>
    36 + ((Date.parse(d) - minTime) / Math.max(maxTime - minTime, 1)) * 400;
  const y = (weight: number) => 126 - (weight / maxWeight) * 100;
  const path =
    points
      .map((p, i) =>
        i
          ? `H ${x(p.effective_from)} V ${y(p.weight)}`
          : `M ${x(p.effective_from)} ${y(p.weight)}`,
      )
      .join(" ") + ` H ${x(lastDay)}`;
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <p className="mb-2 text-xs font-medium">Prescribed weight · kg</p>
      <svg
        viewBox="0 0 460 160"
        className="w-full"
        role="img"
        aria-label={`Weight progression from ${points[0].weight} to ${points.at(-1)!.weight} kg`}
      >
        <line x1="36" x2="436" y1="126" y2="126" stroke="#dce4df" />
        <text x="0" y="30" fontSize="10" fill="#64736c">
          {maxWeight}
        </text>
        <text x="16" y="130" fontSize="10" fill="#64736c">
          0
        </text>
        <path d={path} fill="none" stroke="#176b4f" strokeWidth="2.5" />
        {points.map((p) => (
          <circle
            key={p.exercise_settings_id}
            cx={x(p.effective_from)}
            cy={y(p.weight)}
            r="3"
            fill="#176b4f"
          >
            <title>
              {fmt(p.effective_from)}: {p.weight} kg
            </title>
          </circle>
        ))}
        <text x="36" y="150" fontSize="10" fill="#64736c">
          {fmt(points[0].effective_from)}
        </text>
        <text x="436" y="150" textAnchor="end" fontSize="10" fill="#64736c">
          {fmt(lastDay)}
        </text>
      </svg>
    </div>
  );
}
function ExerciseEditor({
  data,
  exercise,
  run,
  saving,
  close,
}: {
  data: AppData;
  exercise?: Exercise;
  run: Run;
  saving: boolean;
  close: () => void;
}) {
  const history = data.prescriptions
    .filter((p) => p.exercise_id === exercise?.exercise_id)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  const current = exercise
    ? stateFor(data, exercise.exercise_id, localDay())
    : undefined;
  return (
    <div className="space-y-6">
      {exercise && (
        <>
          <h3 className="text-lg font-semibold">{exercise.exercise_name}</h3>
          <Progression history={history} data={data} />
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Prescription history ({history.length})
            </summary>
            <div className="table-wrap mt-3">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>From</th>
                    <th>Until (exclusive)</th>
                    <th>kg</th>
                    <th>Reps × sets</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((p) => (
                    <tr key={p.exercise_settings_id}>
                      <td className="whitespace-nowrap">{p.effective_from}</td>
                      <td>{p.effective_to || "Ongoing"}</td>
                      <td>{p.weight}</td>
                      <td>
                        {p.max_reps} × {p.sets}
                      </td>
                      <td>{p.notes || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      <details open={!exercise}>
        <summary className="mb-4 cursor-pointer text-sm font-medium">
          {exercise ? "Edit exercise details" : "Exercise details"}
        </summary>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            const f = form(e);
            const metadata = {
              name: str(f, "name"),
              muscle_group: str(f, "muscle_group"),
              equipment: str(f, "equipment"),
              description: str(f, "description"),
            };
            const action: Action = exercise
              ? {
                  action: "exercise.update",
                  id: exercise.exercise_id,
                  ...metadata,
                }
              : { action: "exercise.create", ...metadata, ...stateFields(f) };
            if (await run(action)) close();
          }}
        >
          <Field
            label="Exercise name"
            name="name"
            required
            maxLength={120}
            defaultValue={exercise?.exercise_name}
            placeholder="e.g. Barbell squat"
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Muscle group"
              name="muscle_group"
              maxLength={80}
              defaultValue={exercise?.muscle_group || ""}
            />
            <Field
              label="Equipment"
              name="equipment"
              maxLength={80}
              defaultValue={exercise?.equipment || ""}
            />
          </div>
          <Field
            label="Description"
            name="description"
            maxLength={10000}
            defaultValue={exercise?.description || ""}
          />
          {!exercise && (
            <>
              <h3 className="border-t pt-4 text-sm font-semibold">
                Initial prescription
              </h3>
              <StateInputs />
            </>
          )}
          <Save saving={saving}>
            {exercise ? "Save details" : "Create exercise"}
          </Save>
        </form>
      </details>
      {exercise && (
        <>
          <form
            className="space-y-4 border-t pt-5"
            onSubmit={async (e) => {
              const f = form(e);
              if (
                await run(
                  {
                    action: "exercise.state",
                    id: exercise.exercise_id,
                    ...stateFields(f),
                  },
                  "Prescription updated.",
                )
              )
                close();
            }}
          >
            <h3 className="font-semibold">Change prescription</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Applies from the chosen date until the next scheduled change.
              Saving on an existing change date corrects that prescription,
              including historical sessions.
            </p>
            <StateInputs state={current} />
            <Save saving={saving}>Save prescription</Save>
          </form>
          <ArchiveButton
            label="Archive exercise"
            saving={saving}
            onArchive={async () => {
              if (
                await run(
                  { action: "exercise.archive", id: exercise.exercise_id },
                  "Exercise archived. Its history is preserved.",
                )
              )
                close();
            }}
          />
        </>
      )}
    </div>
  );
}
function ArchiveButton({
  label,
  saving,
  onArchive,
}: {
  label: string;
  saving: boolean;
  onArchive: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="border-t pt-4">
      {confirm ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Hide this from your library? Past sessions and prescriptions will
            remain available.
          </p>
          <div className="flex gap-2">
            <Button variant="destructive" disabled={saving} onClick={onArchive}>
              Confirm archive
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          className="text-destructive"
          onClick={() => setConfirm(true)}
        >
          <Trash2 />
          {label}
        </Button>
      )}
    </div>
  );
}
function WorkoutEditor({
  data,
  workout,
  run,
  saving,
  close,
}: {
  data: AppData;
  workout?: Workout;
  run: Run;
  saving: boolean;
  close: () => void;
}) {
  const [effective, setEffective] = useState(localDay());
  const [ids, setIds] = useState(() =>
    workout
      ? membersFor(data, workout.workout_id, effective).map(
          (m) => m.exercise_id,
        )
      : [],
  );
  const choices = data.exercises.filter(
    (e) => e.is_active || ids.includes(e.exercise_id),
  );
  const shift = (index: number, direction: number) => {
    const next = [...ids];
    [next[index], next[index + direction]] = [
      next[index + direction],
      next[index],
    ];
    setIds(next);
  };
  return (
    <div className="space-y-6">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          const f = form(e);
          const values = {
            name: str(f, "name"),
            description: str(f, "description"),
          };
          if (
            await run(
              workout
                ? {
                    action: "workout.update",
                    id: workout.workout_id,
                    ...values,
                  }
                : { action: "workout.create", ...values },
              workout
                ? "Workout updated."
                : "Workout created. Open its editor to add exercises.",
            )
          )
            close();
        }}
      >
        <Field
          label="Workout name"
          name="name"
          required
          maxLength={120}
          defaultValue={workout?.workout_name}
          placeholder="e.g. Upper body"
        />
        <Field
          label="Description (optional)"
          name="description"
          maxLength={10000}
          defaultValue={workout?.description || ""}
        />
        <Save saving={saving}>
          {workout ? "Save details" : "Create workout"}
        </Save>
      </form>
      {workout && (
        <>
          <div className="space-y-4 border-t pt-5">
            <h3 className="font-semibold">Exercises & order</h3>
            <Field
              label="Apply changes from"
              type="date"
              value={effective}
              onChange={(e) => {
                if (!e.target.value) return;
                setEffective(e.target.value);
                setIds(
                  membersFor(data, workout.workout_id, e.target.value).map(
                    (m) => m.exercise_id,
                  ),
                );
              }}
            />
            <p className="text-xs text-muted-foreground">
              Changes apply from this date. Earlier sessions retain their
              original exercise list.
            </p>
            <Select
              aria-label="Add an exercise"
              value=""
              onChange={(e) => {
                if (e.target.value) setIds([...ids, Number(e.target.value)]);
              }}
            >
              <option value="">Add an exercise…</option>
              {choices
                .filter((e) => !ids.includes(e.exercise_id))
                .map((e) => (
                  <option key={e.exercise_id} value={e.exercise_id}>
                    {e.exercise_name}
                  </option>
                ))}
            </Select>
            {ids.length ? (
              <ol className="space-y-2">
                {ids.map((id, i) => (
                  <li
                    key={id}
                    className="flex items-center gap-2 rounded-lg border p-2"
                  >
                    <span className="px-1 text-xs text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 text-sm">
                      {
                        data.exercises.find((e) => e.exercise_id === id)
                          ?.exercise_name
                      }
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Move exercise ${i + 1} up`}
                      disabled={i === 0}
                      onClick={() => shift(i, -1)}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Move exercise ${i + 1} down`}
                      disabled={i === ids.length - 1}
                      onClick={() => shift(i, 1)}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove exercise ${i + 1}`}
                      onClick={() => setIds(ids.filter((x) => x !== id))}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ol>
            ) : (
              <Empty>No exercises in this workout on the selected date.</Empty>
            )}
            <Button
              disabled={saving}
              onClick={async () => {
                if (
                  await run(
                    {
                      action: "workout.members",
                      id: workout.workout_id,
                      exercise_ids: ids,
                      effective_from: effective,
                    },
                    "Workout exercises saved.",
                  )
                )
                  close();
              }}
            >
              <Check /> Save exercises
            </Button>
          </div>
          <ArchiveButton
            label="Archive workout"
            saving={saving}
            onArchive={async () => {
              if (
                await run(
                  { action: "workout.archive", id: workout.workout_id },
                  "Workout archived. Its history is preserved.",
                )
              )
                close();
            }}
          />
        </>
      )}
    </div>
  );
}
function SessionList({
  data,
  sessions,
  open,
}: {
  data: AppData;
  sessions: WorkoutSession[];
  open: (m: Modal) => void;
}) {
  return (
    <div className="divide-y">
      {sessions.map((s) => (
        <button
          key={s.workout_session_id}
          onClick={() => open({ type: "session", id: s.workout_session_id })}
          className="flex w-full items-center gap-3 py-3 text-left hover:text-primary"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/7 text-primary">
            <Check size={17} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {
                data.workouts.find((w) => w.workout_id === s.workout_id)
                  ?.workout_name
              }
            </span>
            <span className="text-xs text-muted-foreground">
              {fmt(s.workout_date)}
            </span>
          </span>
          <ChevronRight size={16} className="text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}
function HistoryPage({
  data,
  open,
}: {
  data: AppData;
  open: (m: Modal) => void;
}) {
  const [filter, setFilter] = useState("");
  const [count, setCount] = useState(30);
  const sessions = data.sessions.filter(
    (s) => !filter || s.workout_id === Number(filter),
  );
  return (
    <>
      <Heading
        eyebrow="History"
        title="Your training history"
        description="Revisit your sessions with the exercises and prescriptions that applied on the day."
      />
      <Card>
        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 className="font-semibold">{sessions.length} sessions</h2>
          <Select
            className="max-w-56"
            aria-label="Filter by workout"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setCount(30);
            }}
          >
            <option value="">All workouts</option>
            {data.workouts.map((w) => (
              <option key={w.workout_id} value={w.workout_id}>
                {w.workout_name}
                {w.is_active ? "" : " (archived)"}
              </option>
            ))}
          </Select>
        </div>
        {sessions.length ? (
          <SessionList
            data={data}
            sessions={sessions.slice(0, count)}
            open={open}
          />
        ) : (
          <Empty>Your logged sessions will appear here.</Empty>
        )}
        {count < sessions.length && (
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => setCount(count + 30)}
          >
            Load more
          </Button>
        )}
      </Card>
    </>
  );
}
function SessionDetail({
  data,
  id,
  run,
  saving,
  close,
}: {
  data: AppData;
  id: number;
  run: Run;
  saving: boolean;
  close: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const session = data.sessions.find((s) => s.workout_session_id === id);
  if (!session) return <Empty>This session is no longer available.</Empty>;
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-xl font-semibold">
          {
            data.workouts.find((w) => w.workout_id === session.workout_id)
              ?.workout_name
          }
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {fmt(session.workout_date)}
        </p>
      </div>
      <PrescriptionTable
        data={data}
        workoutId={session.workout_id}
        day={session.workout_date}
      />
      {session.notes && (
        <p className="whitespace-pre-wrap rounded-lg bg-muted p-4 text-sm">
          {session.notes}
        </p>
      )}
      <div className="border-t pt-4">
        {confirm ? (
          <>
            <p className="mb-3 text-sm text-destructive">
              Permanently delete this session entry?
            </p>
            <Button
              variant="destructive"
              disabled={saving}
              onClick={async () => {
                if (
                  await run(
                    { action: "session.delete", id },
                    "Session deleted.",
                  )
                )
                  close();
              }}
            >
              Delete entry
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            className="text-destructive"
            onClick={() => setConfirm(true)}
          >
            <Trash2 /> Delete entry
          </Button>
        )}
      </div>
    </div>
  );
}

function Admin({
  data,
  run,
  saving,
}: {
  data: AppData;
  run: Run;
  saving: boolean;
}) {
  const [table, setTable] = useState<TableName>("exercise");
  const [changes, setChanges] = useState<
    Record<number, Record<string, string | number | null>>
  >({});
  const [deleted, setDeleted] = useState<number[]>([]);
  const [payload, setPayload] = useState("");
  const [parseError, setParseError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const mapping = {
    exercise: data.exercises,
    workout: data.workouts,
    exercise_settings_history: data.prescriptions,
    workout_exercise: data.memberships,
    workout_session: data.sessions,
  };
  const rows = mapping[table] as unknown as Record<
    string,
    string | number | null
  >[];
  const pk = primaryKeys[table];
  const numeric = new Set([
    "exercise_id",
    "workout_id",
    "exercise_settings_id",
    "workout_exercise_id",
    "workout_session_id",
    "is_active",
    "weight",
    "max_reps",
    "sets",
    "exercise_order",
  ]);
  const reset = () => {
    setChanges({});
    setDeleted([]);
    setConfirm(false);
    setParseError("");
  };
  const save = async () => {
    if (
      await run(
        {
          action: "admin.save",
          table,
          rows: Object.values(changes).filter(
            (r) => !deleted.includes(Number(r[pk])),
          ),
          deleted,
        },
        "Database changes saved.",
      )
    )
      reset();
  };
  const download = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `progresql-${localDay()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <Heading
        eyebrow="Administration"
        title="Data manager"
        description="Inspect, export, and maintain your workout records."
      >
        <Button variant="outline" onClick={download}>
          Export all data
        </Button>
      </Heading>
      <Card>
        <p className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          These edits write directly to the database. Deleting a row is
          permanent. Use the library to archive workouts and exercises while
          keeping their history.
        </p>
        <Select
          aria-label="Database table"
          className="mb-5 max-w-sm"
          value={table}
          onChange={(e) => {
            setTable(e.target.value as TableName);
            reset();
            setPayload("");
          }}
        >
          {tableNames.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </Select>
        <div className="table-wrap max-h-[480px]">
          <table className="data-table">
            <thead>
              <tr>
                <th>Delete</th>
                {tableColumns[table].map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const id = Number(row[pk]);
                return (
                  <tr
                    key={id}
                    className={deleted.includes(id) ? "bg-destructive/5" : ""}
                  >
                    <td>
                      <input
                        aria-label={`Delete row ${id}`}
                        type="checkbox"
                        checked={deleted.includes(id)}
                        onChange={(e) => {
                          setConfirm(false);
                          setDeleted(
                            e.target.checked
                              ? [...deleted, id]
                              : deleted.filter((x) => x !== id),
                          );
                        }}
                      />
                    </td>
                    {tableColumns[table].map((column) => (
                      <td key={column}>
                        {column === pk ? (
                          id
                        ) : (
                          <Input
                            aria-label={`${column} row ${id}`}
                            className="min-w-36"
                            type={numeric.has(column) ? "number" : "text"}
                            step={column === "weight" ? "2.5" : "1"}
                            value={(changes[id] || row)[column] ?? ""}
                            onChange={(e) => {
                              setConfirm(false);
                              const value =
                                e.target.value === ""
                                  ? null
                                  : numeric.has(column)
                                    ? Number(e.target.value)
                                    : e.target.value;
                              setChanges({
                                ...changes,
                                [id]: {
                                  ...(changes[id] || row),
                                  [column]: value,
                                },
                              });
                            }}
                          />
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!rows.length && <Empty>This table is empty.</Empty>}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button
            disabled={
              saving || (!Object.keys(changes).length && !deleted.length)
            }
            onClick={() =>
              deleted.length && !confirm ? setConfirm(true) : void save()
            }
          >
            {confirm
              ? `Confirm deleting ${deleted.length} rows & save`
              : "Save changes"}
          </Button>
          <Button variant="ghost" onClick={reset}>
            Discard edits
          </Button>
          <span className="text-xs text-muted-foreground">
            {Object.keys(changes).length} edited · {deleted.length} marked for
            deletion
          </span>
        </div>
        <details className="mt-6 border-t pt-5">
          <summary className="cursor-pointer text-sm font-medium">
            Add a row with JSON
          </summary>
          <form
            className="mt-4 space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setParseError("");
              try {
                const row: unknown = JSON.parse(payload);
                if (!row || Array.isArray(row) || typeof row !== "object")
                  throw new Error("Enter a JSON object.");
                if (
                  await run(
                    {
                      action: "admin.insert",
                      table,
                      row: row as Record<string, string | number | null>,
                    },
                    "Row added.",
                  )
                )
                  setPayload("");
              } catch (e) {
                setParseError((e as Error).message);
              }
            }}
          >
            <Textarea
              aria-label="New row JSON"
              className="font-mono"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder={'{"column_name": "value"}'}
              required
            />
            {parseError && (
              <p role="alert" className="text-sm text-destructive">
                {parseError}
              </p>
            )}
            <Save saving={saving}>Add row</Save>
          </form>
        </details>
      </Card>
    </>
  );
}
