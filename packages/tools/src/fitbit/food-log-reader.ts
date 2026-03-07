import type { FitbitAuth } from "./auth.js";
import { getDailySaturatedFat } from "../nutrition/sat-fat-tracker.js";

export interface DailySummary {
  date: string;
  saturatedFatGrams: number;
  totalCalories: number;
  rating: "Good" | "Needs improvement";
}

export interface WeeklySummary {
  days: DailySummary[];
  averageSaturatedFat: number;
  rating: "Good" | "Needs improvement";
}

const SAT_FAT_LIMIT = 13; // AHA guideline: <13g/day for ~2000 cal diet

function rate(grams: number): DailySummary["rating"] {
  return grams < SAT_FAT_LIMIT ? "Good" : "Needs improvement";
}

export class FitbitFoodLogReader {
  constructor(
    private auth: FitbitAuth,
    private timezone = "America/Toronto",
  ) {}

  async getFoodLogsForDate(date: string): Promise<{
    summary: { saturatedFat: number; calories: number };
  }> {
    const token = await this.auth.getAccessToken();
    const res = await fetch(
      `https://api.fitbit.com/1/user/-/foods/log/date/${date}.json`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Fitbit API error ${res.status}: ${error}`);
    }

    const data = (await res.json()) as {
      summary: { saturatedFat: number; calories: number };
    };
    return data;
  }

  async getDailySummary(date: string): Promise<DailySummary> {
    const [data, localSatFat] = await Promise.all([
      this.getFoodLogsForDate(date),
      getDailySaturatedFat(date),
    ]);
    // Use local tracker for sat fat (Fitbit API doesn't include it in summary)
    const satFat = localSatFat;
    return {
      date,
      saturatedFatGrams: Math.round(satFat * 10) / 10,
      totalCalories: data.summary.calories ?? 0,
      rating: rate(satFat),
    };
  }

  async getWeeklySummary(endDate?: string): Promise<WeeklySummary> {
    const end = endDate
      ? new Date(endDate + "T12:00:00")
      : new Date(
          new Date().toLocaleString("en-US", { timeZone: this.timezone }),
        );

    const dates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(end);
      d.setDate(d.getDate() - i);
      dates.push(d.toLocaleDateString("en-CA"));
    }

    const days = await Promise.all(
      dates.map((date) => this.getDailySummary(date)),
    );

    const avg =
      days.reduce((sum, d) => sum + d.saturatedFatGrams, 0) / days.length;

    return {
      days,
      averageSaturatedFat: Math.round(avg * 10) / 10,
      rating: rate(avg),
    };
  }
}
