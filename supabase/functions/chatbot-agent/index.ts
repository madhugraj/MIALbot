import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function callGemini(apiKey, prompt) {
  const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
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
  if (geminiData.candidates && geminiData.candidates[0].content && geminiData.candidates[0].content.parts) {
    return geminiData.candidates[0].content.parts[0].text;
  }
  
  if (geminiData.parts) {
    return geminiData.parts[0].text;
  }

  console.error("Unrecognized Gemini response structure:", geminiData);
  throw new Error("Gemini response did not contain expected content structure.");
}

function formatHistory(history) {
    if (!history || history.length === 0) return "No conversation history yet.";
    return history.map(msg => `${msg.sender === 'user' ? 'User' : 'Assistant'}: ${msg.text}`).join('\n');
}

async function handleTextToSQLQuery(supabase, geminiApiKey, user_query, formattedHistory) {
  const { data: schemaData, error: schemaError } = await supabase
    .from('schema_metadata')
    .select('schema_json')
    .eq('table_name', 'flight_schedule')
    .single();

  if (schemaError || !schemaData) {
    console.error('Schema Fetch Error:', schemaError);
    return { response: "I'm sorry, I can't access my knowledge base right now. Please try again later.", generatedSql: null };
  }
  const schemaDefinition = JSON.stringify(schemaData.schema_json, null, 2);
  const today = new Date().toISOString().split('T')[0];

  const sqlGenerationPrompt = `You are a hyper-literal, no-nonsense PostgreSQL query generation engine. Your ONLY purpose is to generate a single, read-only SQL query based on a user's question and a provided database schema. You must follow all rules to the letter.

**DATABASE SCHEMA for the 'flight_schedule' table:**
\`\`\`json
${schemaDefinition}
\`\`\`

**COLUMN EXPLANATIONS & USAGE:**
*   \`operational_status_description\`: **USE THIS FOR FLIGHT STATUS.** This is the primary field for human-readable flight status (e.g., "On Time", "Delayed", "Cancelled").
*   \`arrival_airport_name\`: The name of the arrival airport. **USE THIS to answer questions about the flight's "destination" or "arrival location".**
*   \`departure_airport_name\`: The name of the departure airport. **USE THIS to answer questions about where a flight is "coming from".**
*   \`gate_name\`: The specific gate for the flight (e.g., "A12").
*   \`terminal_name\`: The terminal where the gate is located (e.g., "Terminal 1").
*   \`delay_duration\`: The length of any delay. Use this to answer questions about how long a flight is delayed.
*   \`remark_free_text\`: Provides additional context or reasons for the flight's status (e.g., "Delayed due to weather").
*   **Time Fields**:
    *   Use \`scheduled_departure_time\` or \`scheduled_arrival_time\` for scheduled times.
    *   Use \`estimated_departure_time\` or \`estimated_arrival_time\` for current estimated times, which include delays.
    *   Use \`actual_departure_time\` or \`actual_arrival_time\` for times after the event has occurred.

**EXAMPLES:**
*   **User Question:** "What is the status of flight BA2490?"
    **SQL Query:** \`SELECT operational_status_description, remark_free_text FROM public.flight_schedule WHERE flight_number ILIKE '%BA2490%' AND DATE(origin_date_time) = '${today}'\`
*   **User Question:** "When is flight 920 arriving on july 12 and where is it coming from?"
    **SQL Query:** \`SELECT estimated_arrival_time, departure_airport_name FROM public.flight_schedule WHERE flight_number ILIKE '%920%' AND DATE(origin_date_time) = '2024-07-12'\`
*   **User Question:** "Is flight DL456 delayed?"
    **SQL Query:** \`SELECT operational_status_description, delay_duration FROM public.flight_schedule WHERE flight_number ILIKE '%DL456%' AND DATE(origin_date_time) = '${today}'\`

**CRITICAL RULES:**
1.  **ABSOLUTE SCHEMA ADHERENCE:** You MUST ONLY use the columns explicitly listed in the schema and explanations above. DO NOT use any column that is not in that list. DO NOT invent columns.
2.  **SCHEMA PREFIX REQUIRED:** You MUST prefix the table name with its schema: \`public.flight_schedule\`. Queries without this prefix will fail.
3.  **READ-ONLY:** The query MUST be a \`SELECT\` statement.
4.  **CASE-INSENSITIVE SEARCH:** For all string comparisons (e.g., on \`airline_code\`, \`flight_number\`, \`departure_airport_name\`), you MUST use the \`ILIKE\` operator with wildcards (\`%\`).
5.  **DATE HANDLING:** The current date is ${today}. For date comparisons, you MUST cast the timestamp column to a date: \`DATE(origin_date_time) = 'YYYY-MM-DD'\`. If the user does not provide a year, assume the current year.
6.  **NO GUESSING / UNANSWERABLE QUESTIONS:** If the user's question CANNOT be answered using the provided schema, DO NOT generate a query. Instead, you MUST output the exact text: "UNANSWERABLE".
7.  **OUTPUT FORMAT:** Your output MUST be the raw SQL query and nothing else. Do not include any explanations, comments, or markdown.

**CONVERSATION HISTORY:**
${formattedHistory}

**USER'S QUESTION:**
"${user_query}"

**SQL QUERY:**`;

  const generatedSql = (await callGemini(geminiApiKey, sqlGenerationPrompt)).replace(/```sql\n|```/g, '').trim();
  console.log("Generated SQL:", generatedSql);

  if (!generatedSql || generatedSql.toUpperCase() === 'UNANSWERABLE' || !generatedSql.toUpperCase().startsWith('SELECT')) {
      console.error("SQL Generation Failed or Unanswerable. Response:", generatedSql);
      return { response: "I'm sorry, I can't answer that question with the information I have. Could you try asking about flight status, gates, or times?", generatedSql: generatedSql || "Failed to generate valid SQL." };
  }

  const { data: queryResult, error: queryError } = await supabase.rpc('execute_sql_query', { query_text: generatedSql });

  if (queryError) {
    console.error('SQL Execution Error:', queryError);
    return { response: `I'm sorry, I ran into a database error.`, generatedSql };
  }

  if (queryResult && Array.isArray(queryResult) && query_result.length > 0) {
    const summarizationPrompt = `You are Mia, a helpful flight assistant. Your task is to provide a clear and direct answer to the user's question based on the database results and conversation history.

**Conversation History:**
${formattedHistory}
**User's Latest Question:** "${user_query}"
**Database Results (JSON):**
\`\`\`json
${JSON.stringify(queryResult, null, 2)}
\`\`\`
**Your Answer (be conversational and helpful):**`;
    
    const summary = await callGemini(geminiApiKey, summarizationPrompt);
    return { response: summary, generatedSql };
  }

  return { response: `I couldn't find any information for your query. Please check the details and try again.`, generatedSql };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { user_query, history } = await req.json();
    const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
    if (!geminiApiKey) throw new Error('GEMINI_API_KEY is not set.');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );
    
    const formattedHistory = formatHistory(history);
    const result = await handleTextToSQLQuery(supabase, geminiApiKey, user_query, formattedHistory);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    console.error('Edge Function Catch Block Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});