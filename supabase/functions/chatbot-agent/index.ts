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
  console.log("Inside handleTextToSQLQuery");

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

  const sqlGenerationPrompt = `You are a hyper-literal, no-nonsense PostgreSQL query generation engine. Your ONLY purpose is to generate a single, read-only SQL query based on a user's question and a provided database schema. You must follow all rules to the letter.

**DATABASE SCHEMA for the 'flight_schedule' table:**
\`\`\`json
${schemaDefinition}
\`\`\`

**CRITICAL RULES:**
1.  **ABSOLUTE SCHEMA ADHERENCE:** You MUST ONLY use the columns explicitly listed in the schema above. DO NOT use any column that is not in that list. DO NOT invent columns. If a user asks for "price" and there is no "price" column, you cannot answer.
2.  **READ-ONLY:** The query MUST be a \`SELECT\` statement. No other type of query is permitted.
3.  **CASE-INSENSITIVE SEARCH:** For all string comparisons (e.g., on \`airline_code\`, \`flight_number\`, \`departure_airport_name\`), you MUST use the \`ILIKE\` operator with wildcards (\`%\`). This is not optional.
4.  **DATE HANDLING:** The current date is ${new Date().toISOString().split('T')[0]}. For date comparisons, you MUST cast the timestamp column to a date: \`DATE(origin_date_time) = 'YYYY-MM-DD'\`.
5.  **NO GUESSING / UNANSWERABLE QUESTIONS:** If the user's question CANNOT be answered using the provided schema, DO NOT generate a query. Instead, you MUST output the exact text: "UNANSWERABLE".
6.  **OUTPUT FORMAT:** Your output MUST be the raw SQL query and nothing else. Do not include any explanations, comments, or markdown like \`\`\`sql.

**EXAMPLE:**
*   **User Question:** "is flight ua 456 to denver on time?"
*   **Correct SQL Output:** SELECT operational_status_description, scheduled_departure_time FROM public.flight_schedule WHERE flight_number ILIKE '%456%' AND arrival_airport_name ILIKE '%denver%'
*   **Incorrect SQL Output:** SELECT status FROM flights WHERE flight_id = 'ua 456' -- (This is WRONG because the table is 'flight_schedule' and the column is 'flight_number', not 'flight_id')

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

  if (queryResult && Array.isArray(queryResult) && queryResult.length > 0) {
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

async function handleStructuredSearch(supabase, geminiApiKey, searchParams) {
  console.log("Inside handleStructuredSearch (RPC)");
  const { airlineCode, flightNumber, date } = searchParams;

  const { data: queryResult, error: queryError } = await supabase.rpc('get_flight_info', {
    p_airline_code: airlineCode,
    p_flight_number: flightNumber,
    p_origin_date: date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
  });

  const rpcDetails = `RPC: get_flight_info(${JSON.stringify({
    p_airline_code: airlineCode,
    p_flight_number: flightNumber,
    p_origin_date: date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
  }, null, 2)})`;

  if (queryError) {
    console.error('RPC Execution Error:', queryError);
    return { response: `I'm sorry, I ran into a database error while searching.`, generatedSql: rpcDetails };
  }

  if (queryResult && Array.isArray(queryResult) && queryResult.length > 0) {
    const summarizationPrompt = `You are Mia, a helpful flight assistant. Your task is to provide a clear and direct summary of the flight information found.

**User's Search Criteria:**
${JSON.stringify(searchParams)}

**Database Results (JSON):**
\`\`\`json
${JSON.stringify(queryResult, null, 2)}
\`\`\`
**Your Answer (be conversational and helpful, summarize the key information from the result):**`;
    
    const summary = await callGemini(geminiApiKey, summarizationPrompt);
    return { response: summary, generatedSql: rpcDetails };
  }

  return { response: `I couldn't find any flight information for your search. Please check the details and try again.`, generatedSql: rpcDetails };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { user_query, history, searchParams } = await req.json();
    const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
    if (!geminiApiKey) throw new Error('GEMINI_API_KEY is not set.');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );
    
    let result;

    if (searchParams) {
      console.log("Routing to STRUCTURED_SEARCH tool.");
      result = await handleStructuredSearch(supabase, geminiApiKey, searchParams);
    } else {
      console.log("Routing to TEXT_TO_SQL tool.");
      const formattedHistory = formatHistory(history);
      result = await handleTextToSQLQuery(supabase, geminiApiKey, user_query, formattedHistory);
    }

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