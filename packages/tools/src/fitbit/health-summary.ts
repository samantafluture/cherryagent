import type { FitbitAuth } from "./auth.js";

export interface FitbitHealthSummary {
  date: string;
  activity: {
    steps: number;
    caloriesOut: number;
    activeMinutes: number; // fairly + very active combined
  };
  nutrition: {
    caloriesIn: number;
    protein: number; // grams
    carbs: number;   // grams
    fat: number;     // grams
    deficit: number; // caloriesOut - caloriesIn (positive = deficit)
  };
  sleep: {
    durationMinutes: number;
    efficiency: number; // percentage 0-100
    startTime: string | null;
  };
  heart: {
    restingHeartRate: number | null;
  };
  weight: {
    kg: number | null;
    lastLoggedDate: string | null;
  };
}

async function fitbitGet(
  token: string,
  path: string,
): Promise<unknown> {
  const res = await fetch(`https://api.fitbit.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Fitbit API error ${res.status} for ${path}`);
  }
  return res.json();
}

export async function getFitbitHealthSummary(
  auth: FitbitAuth,
  date: string,
  timezone = "America/Toronto",
): Promise<FitbitHealthSummary> {
  const token = await auth.getAccessToken();

  // Resolve "today" to a real date string in the user's timezone
  const resolvedDate =
    date === "today"
      ? new Date().toLocaleDateString("en-CA", { timeZone: timezone })
      : date;

  const [activityRaw, nutritionRaw, sleepRaw, heartRaw, weightRaw] =
    await Promise.allSettled([
      fitbitGet(token, `/1/user/-/activities/date/${resolvedDate}.json`),
      fitbitGet(token, `/1/user/-/foods/log/date/${resolvedDate}.json`),
      fitbitGet(token, `/1/user/-/sleep/date/${resolvedDate}.json`),
      fitbitGet(
        token,
        `/1/user/-/activities/heart/date/${resolvedDate}/1d.json`,
      ),
      fitbitGet(token, `/1/user/-/body/log/weight/date/${resolvedDate}.json`),
    ]);

  // --- Activity ---
  let steps = 0;
  let caloriesOut = 0;
  let activeMinutes = 0;
  if (activityRaw.status === "fulfilled") {
    const a = activityRaw.value as {
      summary?: {
        steps?: number;
        caloriesOut?: number;
        fairlyActiveMinutes?: number;
        veryActiveMinutes?: number;
      };
    };
    steps = a.summary?.steps ?? 0;
    caloriesOut = a.summary?.caloriesOut ?? 0;
    activeMinutes =
      (a.summary?.fairlyActiveMinutes ?? 0) +
      (a.summary?.veryActiveMinutes ?? 0);
  }

  // --- Nutrition ---
  let caloriesIn = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  if (nutritionRaw.status === "fulfilled") {
    const n = nutritionRaw.value as {
      summary?: {
        calories?: number;
        protein?: number;
        carbs?: number;
        fat?: number;
      };
    };
    caloriesIn = n.summary?.calories ?? 0;
    protein = n.summary?.protein ?? 0;
    carbs = n.summary?.carbs ?? 0;
    fat = n.summary?.fat ?? 0;
  }

  // --- Sleep ---
  let durationMinutes = 0;
  let efficiency = 0;
  let sleepStartTime: string | null = null;
  if (sleepRaw.status === "fulfilled") {
    const s = sleepRaw.value as {
      summary?: { totalMinutesAsleep?: number };
      sleep?: Array<{
        isMainSleep?: boolean;
        efficiency?: number;
        startTime?: string;
      }>;
    };
    durationMinutes = s.summary?.totalMinutesAsleep ?? 0;
    const mainSleep = s.sleep?.find((e) => e.isMainSleep) ?? s.sleep?.[0];
    efficiency = mainSleep?.efficiency ?? 0;
    sleepStartTime = mainSleep?.startTime ?? null;
  }

  // --- Heart rate ---
  let restingHeartRate: number | null = null;
  if (heartRaw.status === "fulfilled") {
    const h = heartRaw.value as {
      "activities-heart"?: Array<{
        value?: { restingHeartRate?: number };
      }>;
    };
    restingHeartRate =
      h["activities-heart"]?.[0]?.value?.restingHeartRate ?? null;
  }

  // --- Weight ---
  let weightKg: number | null = null;
  let lastLoggedDate: string | null = null;
  if (weightRaw.status === "fulfilled") {
    const w = weightRaw.value as {
      weight?: Array<{ weight?: number; date?: string }>;
    };
    const latest = w.weight?.[w.weight.length - 1];
    weightKg = latest?.weight ?? null;
    lastLoggedDate = latest?.date ?? null;
  }

  return {
    date: resolvedDate,
    activity: { steps, caloriesOut, activeMinutes },
    nutrition: {
      caloriesIn,
      protein,
      carbs,
      fat,
      deficit: caloriesOut - caloriesIn,
    },
    sleep: {
      durationMinutes,
      efficiency,
      startTime: sleepStartTime,
    },
    heart: { restingHeartRate },
    weight: { kg: weightKg, lastLoggedDate },
  };
}
