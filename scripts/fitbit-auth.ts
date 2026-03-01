/**
 * Manual Fitbit OAuth2 authorization flow.
 * Run: pnpm tsx --env-file=.env scripts/fitbit-auth.ts
 *
 * Step 1: Opens the auth URL — authorize in your browser.
 * Step 2: After authorizing, Fitbit redirects to localhost.
 *         Copy the "code" parameter from the URL bar.
 * Step 3: Paste the code when prompted (or pass as CLI arg).
 */

import { FitbitAuth } from "../packages/tools/src/fitbit/auth.js";
import { createInterface } from "node:readline";

const clientId = process.env.FITBIT_CLIENT_ID;
const clientSecret = process.env.FITBIT_CLIENT_SECRET;
const redirectUri =
  process.env.FITBIT_REDIRECT_URI ??
  "http://localhost:3000/api/fitbit/callback";

if (!clientId || !clientSecret) {
  console.error("FITBIT_CLIENT_ID and FITBIT_CLIENT_SECRET required in .env");
  process.exit(1);
}

const auth = new FitbitAuth({ clientId, clientSecret, redirectUri });

async function main() {
  const codeArg = process.argv[2];

  if (!codeArg) {
    // Step 1: Show auth URL
    const url = auth.getAuthUrl();
    console.log("Open this URL in your browser:\n");
    console.log(url);
    console.log(
      "\nAfter authorizing, the browser will redirect to localhost.",
    );
    console.log(
      "Even if the page fails to load, copy the URL from the address bar.",
    );
    console.log(
      "Find the 'code' parameter: ...callback?code=THIS_PART#_=_\n",
    );

    // Step 2: Prompt for code
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const code = await new Promise<string>((resolve) => {
      rl.question("Paste the code here: ", (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });

    await exchangeCode(code);
  } else {
    await exchangeCode(codeArg);
  }
}

async function exchangeCode(code: string) {
  console.log("\nExchanging code for tokens...");

  try {
    await auth.exchangeCode(code);
    console.log("Fitbit connected! Tokens saved to ~/.cherryagent/fitbit-tokens.json");
  } catch (err) {
    console.error(
      "Failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
}

main();
