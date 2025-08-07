import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(SUPABASE_URL ?? '', SUPABASE_SERVICE_ROLE_KEY ?? '', {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set.');
  const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  if (!geminiResponse.ok) {
    const errorText = await geminiResponse.text();
    console.error(`Gemini API error: ${geminiResponse.status} - ${errorText}`);
    throw new Error(`Failed to get response from Gemini API: ${geminiResponse.statusText}`);
  }

  const geminiData = await geminiResponse.json();
  const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || geminiData.parts?.[0]?.text;
  if (text) {
    return text.replace(/```json\n|```/g, '').trim();
  }

  console.error("Unrecognized Gemini response structure:", geminiData);
  throw new Error("Gemini response did not contain expected content structure.");
}

function formatHistory(history) {
  if (!history || history.length === 0) return "No conversation history yet.";
  return history.map(msg => `${msg.sender === 'user' ? 'User' : 'Assistant'}: ${msg.text}`).join('\n');
}

async function handleSpecificFlightQuery(user_query, history) {
  const formattedHistory = formatHistory(history);
  const today = new Date().toISOString().split('T')[0];

  const parameterExtractionPrompt = `You are a stateful, context-aware entity extraction engine. Your job is to understand an ongoing conversation about flights and maintain context. Once a flight's context (airline_code, flight_number, origin_date) is established, you MUST carry it forward.

**INSTRUCTIONS:**
1.  **Analyze Full History & Latest Message:** Read the entire conversation to establish context.
2.  **Apply Context:** Interpret the "LATEST USER MESSAGE" using the established context. If the user asks "and what's the gate?", you must use the flight number and date from previous turns.
3.  **Date Parsing:** You MUST parse natural language dates (e.g., "July 26th", "tomorrow") into the 'YYYY-MM-DD' format. Today is ${today}.
4.  **Output Format:** Your entire output MUST be a single JSON object.

**CLARIFICATION & LOOP PREVENTION:**
*   If a required parameter (like \`origin_date\`) is missing and not in the history, you MUST ask for it by outputting: \`{"requires_clarification": true, "missing_parameter": "date", "flight_number": "<flight_number>", "airline_code": "<airline_code>"}\`.
*   **Anti-Loop:** If you have just asked for a date, and the user's latest message is the answer, you MUST combine it with the previous context and output the full parameter JSON. DO NOT ask for clarification again.

---
**ANALYZE THE FOLLOWING CONVERSATION:**

**CONVERSATION HISTORY:**
${formattedHistory}

**LATEST USER MESSAGE:**
"${user_query}"

**YOUR RESPONSE (JSON object only):**`;

  const paramsJson = await callGemini(parameterExtractionPrompt);
  const params = JSON.parse(paramsJson);

  if (params.requires_clarification) {
    // This part can be expanded to suggest dates if needed
    return { response: `I can help with that. Which date are you interested in?` };
  }

  const { data, error } = await supabase.rpc('get_flight_info', {
    p_airline_code: params.airline_code || null,
    p_flight_number: params.flight_number || null,
    p_origin_date: params.origin_date || null,
  });

  if (error || !data || data.length === 0) {
    console.error('RPC Error or no data:', error);
    return { response: `I couldn't find any information for your query. Please check the details and try again.` };
  }

  const resultData = JSON.stringify(data[0]);
  const summarizationPrompt = `You are Mia, a helpful flight assistant. Your goal is to provide a direct, concise answer to the user's latest question using the provided data, then offer relevant follow-up suggestions.

**INSTRUCTIONS:**
1.  **Identify Core Question:** Determine what the user is asking for (e.g., "status", "gate", "is it international?").
2.  **Formulate Answer:** Find the answer in the "Database Result (JSON)" and create a direct, conversational sentence.
3.  **Create Follow-ups:** Based on *other* available data, create a list of 2-3 short, relevant questions the user might ask next.
4.  **Output Format:** Your entire output MUST be a single JSON object with two keys: \`answer\` (string) and \`suggestions\` (array of strings).

---
**User's Latest Question:** "${user_query}"
**Database Result (JSON):**
\`\`\`json
${resultData}
\`\`\`
**Your Response (JSON object only):**`;

  const summaryJson = await callGemini(summarizationPrompt);
  const summary = JSON.parse(summaryJson);
  return {
    response: summary.answer,
    followUpSuggestions: summary.suggestions,
    generatedSql: `RPC: get_flight_info, Params: ${JSON.stringify(params)}`,
  };
}

async function handleAnalyticalQuery(user_query) {
  const today = new Date().toISOString().split('T')[0];
  const textToSqlPrompt = `You are a PostgreSQL expert. Write a single, valid SQL SELECT query to answer the user's analytical question about flight data.

**DATABASE SCHEMA:**
Table: \`public.flight_schedule\`
Columns: \`airline_code\`, \`flight_number\`, \`flight_type\`, \`operational_status_description\`, \`departure_airport_name\`, \`arrival_airport_name\`, \`scheduled_departure_time\` (timestamp), \`delay_duration\` (interval), \`origin_date_time\` (timestamp).

**RULES:**
1.  You MUST only generate a single \`SELECT\` query.
2.  A flight is delayed if \`delay_duration > '0 minutes'::interval\`.
3.  Use \`DATE(origin_date_time)\` for date-based queries. Today's date is ${today}.
4.  For "constantly delayed" flights, count flights with delays, group by flight number, and order by the count descending.

**USER'S QUESTION:**
"${user_query}"

**YOUR RESPONSE (JSON object with a single "sql_query" key):**`;

  const sqlJson = await callGemini(textToSqlPrompt);
  const { sql_query } = JSON.parse(sqlJson);

  if (!sql_query) {
    return { response: "I wasn't able to construct a query for that question. Please try rephrasing it." };
  }

  const { data, error } = await supabase.rpc('execute_sql_query', { query_text: sql_query });

  if (error) {
    console.error('SQL Execution Error:', error);
    return { response: `I'm sorry, I ran into a database error while analyzing the data.`, generatedSql: sql_query };
  }

  const summarizationPrompt = `You are Mia, a helpful flight assistant. Provide a clear, natural language answer based on the user's question and the data returned from the database.

**USER'S QUESTION:**
"${user_query}"

**SQL QUERY THAT WAS EXECUTED:**
\`\`\`sql
${sql_query}
\`\`\`

**DATABASE RESULT (JSON):**
\`\`\`json
${JSON.stringify(data)}
\`\`\`

**YOUR RESPONSE (a single, conversational string):**`;

  const summary = await callGemini(summarizationPrompt);
  return { response: summary, generatedSql: sql_query };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { user_query, history } = await req.json();
    const formattedHistory = formatHistory(history);

    const intentClassificationPrompt = `You are an intent classification model. Determine if a user's request is a \`SPECIFIC_FLIGHT_LOOKUP\` or an \`ANALYTICAL_QUERY\`.

- \`SPECIFIC_FLIGHT_LOOKUP\`: Asks for details about a single, specific flight (e.g., "status of BA2490?", "what is the gate?"). Usually contains a flight number.
- \`ANALYTICAL_QUERY\`: Requires counting, aggregating, or analyzing multiple flights (e.g., "how many flights are delayed?", "which airline has the most flights?").

**CONVERSATION HISTORY:**
${formattedHistory}

**LATEST USER MESSAGE:**
"${user_query}"

**Your response must be a single JSON object with one key, "intent", set to either "SPECIFIC_FLIGHT_LOOKUP" or "ANALYTICAL_QUERY".**`;

    const intentJson = await callGemini(intentClassificationPrompt);
    const { intent } = JSON.parse(intentJson);

    let result;
    if (intent === 'ANALYTICAL_QUERY') {
      result = await handleAnalyticalQuery(user_query);
    } else {
      result = await handleSpecificFlightQuery(user_query, history);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    console.error('Edge Function Catch Block Error:', error);
    return new Response(JSON.stringify({ error: "Sorry, I've run into an unexpected error." }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});