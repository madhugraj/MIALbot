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

  const sqlGenerationPrompt = `You are a hyper-literal, no-nonsense PostgreSQL query generation engine. Your ONLY purpose is to generate a single, read-only SQL query or a JSON object for clarification. You must follow all rules to the letter.

**DATABASE SCHEMA for the 'flight_schedule' table:**
\`\`\`json
${schemaDefinition}
\`\`\`

**CRITICAL RULES:**
1.  **CONTEXTUAL AWARENESS:** You MUST use the entire **CONVERSATION HISTORY** to understand the user's intent. If the user provides a piece of information (like a date) that answers a question you previously asked, you MUST combine it with the previous context to form a complete query.
2.  **AMBIGUITY DETECTION:** If a user's question is ambiguous because a date is missing for a date-sensitive query (like status, duration, gate), you MUST NOT guess the date. Instead, your entire output MUST be a single JSON object with this exact structure: \`{"requires_clarification": true, "query_for_options": "SELECT DISTINCT TO_CHAR(origin_date_time, 'YYYY-MM-DD') AS option FROM public.flight_schedule WHERE flight_number ILIKE '%<flight_number>%' ORDER BY option DESC"}\`. Replace \`<flight_number>\` with the flight number from the user's query.
3.  **NORMAL OPERATION:** If the question is unambiguous (e.g., a date is provided, or a date was provided in a previous turn), generate the SQL query as normal. Do not wrap it in JSON.
4.  **SCHEMA ADHERENCE:** You MUST ONLY use the columns explicitly listed in the schema.
5.  **DURATION CALCULATION:** To calculate travel duration, you MUST calculate the difference between arrival and departure times. Use \`COALESCE\` to ensure a value is present, preferring \`actual\` times but falling back to \`estimated\` times. The formula MUST be: \`(COALESE(actual_arrival_time, estimated_arrival_time) - COALESCE(actual_departure_time, estimated_departure_time))\`. This produces a human-readable interval. **DO NOT use \`EXTRACT\` or other complex functions.**
6.  **READ-ONLY:** The query MUST be a \`SELECT\` statement.
7.  **CASE-INSENSITIVE SEARCH:** For all string comparisons, you MUST use the \`ILIKE\` operator with wildcards (\`%\`).
8.  **DATE HANDLING:** When a date is provided, you MUST cast the timestamp column to a date: \`DATE(origin_date_time) = 'YYYY-MM-DD'\`.
9.  **UNANSWERABLE QUESTIONS:** If a question cannot be answered, output the exact text: "UNANSWERABLE".
10. **OUTPUT FORMAT:** Your output must be either the raw SQL query OR the JSON object for clarification. Nothing else.

**EXAMPLES:**
*   **User Question:** "What is the status of flight BA2490 on July 12 2024?" (Unambiguous)
    **SQL Query:** \`SELECT operational_status_description, remark_free_text FROM public.flight_schedule WHERE flight_number ILIKE '%BA2490%' AND DATE(origin_date_time) = '2024-07-12'\`
*   **Conversation History:**
    User: "What is the travel duration for flight AA100?"
    Assistant: "I found several dates for that flight. Which one are you interested in?"
    **User Question:** "2024-07-12"
    **SQL Query:** \`SELECT (COALESCE(actual_arrival_time, estimated_arrival_time) - COALESCE(actual_departure_time, estimated_departure_time)) AS travel_duration FROM public.flight_schedule WHERE flight_number ILIKE '%AA100%' AND DATE(origin_date_time) = '2024-07-12'\`

**CONVERSATION HISTORY:**
${formattedHistory}

**USER'S QUESTION:**
"${user_query}"

**YOUR RESPONSE (SQL or JSON):**`;

  const geminiResponse = (await callGemini(geminiApiKey, sqlGenerationPrompt)).replace(/```json\n|```|```sql\n/g, '').trim();
  console.log("Gemini Raw Response:", geminiResponse);

  let parsedResponse;
  try {
    parsedResponse = JSON.parse(geminiResponse);
  } catch (e) {
    parsedResponse = null;
  }

  if (parsedResponse && parsedResponse.requires_clarification) {
    console.log("Clarification needed. Query for options:", parsedResponse.query_for_options);
    const { data: options, error: optionsError } = await supabase.rpc('execute_sql_query', { query_text: parsedResponse.query_for_options });

    if (optionsError || !options || options.length === 0) {
      console.error('Error fetching options or no options found:', optionsError);
      return { response: "I couldn't find any dates for that flight. Please check the flight number and try again.", generatedSql: parsedResponse.query_for_options };
    }

    return {
      response: `I found several dates for that flight. Which one are you interested in?`,
      generatedSql: parsedResponse.query_for_options,
      requiresFollowUp: true,
      followUpOptions: options.map(opt => opt.option)
    };
  }

  let generatedSql = '';
  const selectIndex = geminiResponse.toUpperCase().indexOf('SELECT');
  if (selectIndex > -1) {
    generatedSql = geminiResponse.substring(selectIndex);
  } else {
    generatedSql = geminiResponse;
  }

  if (!generatedSql || generatedSql.toUpperCase().trim() === 'UNANSWERABLE' || !generatedSql.toUpperCase().startsWith('SELECT')) {
      console.error("SQL Generation Failed or Unanswerable. Response:", generatedSql);
      return { response: "I'm sorry, I can't answer that question with the information I have.", generatedSql: generatedSql || "Failed to generate valid SQL." };
  }

  const { data: queryResult, error: queryError } = await supabase.rpc('execute_sql_query', { query_text: generatedSql });

  if (queryError) {
    console.error('SQL Execution Error:', queryError);
    return { response: `I'm sorry, I ran into a database error.`, generatedSql };
  }

  if (queryResult && Array.isArray(queryResult) && queryResult.length > 0) {
    const firstResult = queryResult[0];
    const resultData = JSON.stringify(firstResult);

    const summarizationPrompt = `You are Mia, a helpful flight assistant. Your task is to provide a clear and direct answer to the user's question based on the JSON data provided.

**CRITICAL RULES:**
1.  **Analyze the User's Question:** Understand what the user is asking for (e.g., status, gate, duration).
2.  **Analyze the JSON Data:** Look at the key-value pairs in the JSON to find the answer.
3.  **Handle Multiple Fields:** If the JSON contains multiple relevant fields (like a status and a remark), combine them into a single, coherent sentence.
4.  **Handle Missing/Null Values:** If a value in the JSON is 'null' or an empty string, you MUST state that the specific piece of information is not available. Do not ignore it. If all values are null, state that you couldn't find any details.

**Conversation History:**
${formattedHistory}
**User's Latest Question:** "${user_query}"
**Database Result (JSON):**
\`\`\`json
${resultData}
\`\`\`

**Your Answer (be conversational and helpful):**`;
    
    const summary = await callGemini(geminiApiKey, summarizationPrompt);

    if (!summary || summary.trim() === "") {
        console.error("Summarization failed: Gemini returned an empty response.");
        return { response: "I found the information, but I had trouble summarizing it. Please try rephrasing your question.", generatedSql };
    }

    const followUpPrompt = `Based on the user's question and the data provided, generate 2-3 relevant, short follow-up questions a user might ask next. The questions should be distinct from the original question. Output them as a JSON array of strings. If no logical follow-up questions can be generated, return an empty array [].

**User's Question:** "${user_query}"
**Data Provided:** ${resultData}

**Example 1:**
User Question: "What's the status of flight BA2490?"
Data: {"operational_status_description": "On Time", "remark_free_text": null}
Your Output: ["What is the gate number?", "What is the scheduled arrival time?"]

**Example 2:**
User Question: "What is the gate for flight DL456?"
Data: {"gate_name": "A12"}
Your Output: ["What is the boarding time?", "Is the flight on time?"]

Your Output (JSON array of strings):`;

    const followUpResponse = await callGemini(geminiApiKey, followUpPrompt);
    let followUpSuggestions = [];
    try {
        const cleanedResponse = followUpResponse.replace(/```json\n|```/g, '').trim();
        const parsed = JSON.parse(cleanedResponse);
        if (Array.isArray(parsed)) {
            followUpSuggestions = parsed;
        }
    } catch (e) {
        console.error("Failed to parse follow-up suggestions:", e);
        followUpSuggestions = [];
    }

    return { response: summary, generatedSql, followUpSuggestions };
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