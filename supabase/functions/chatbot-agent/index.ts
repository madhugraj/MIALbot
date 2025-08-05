import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper to call the Gemini API
async function callGemini(apiKey, prompt) {
  const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
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
  
  throw new Error("Gemini response did not contain expected content structure.");
}

// Helper to format history
function formatHistory(history) {
    if (!history || history.length === 0) return "No conversation history yet.";
    return history.map(msg => `${msg.sender === 'user' ? 'User' : 'Assistant'}: ${msg.text}`).join('\n');
}

// Tool 1: Flight Query Logic
async function handleFlightQuery(supabase, geminiApiKey, user_query, formattedHistory) {
  console.log("Inside handleFlightQuery");
  const { data: schemaData, error: schemaError } = await supabase
    .from('schema_metadata')
    .select('schema_json')
    .eq('table_name', 'flight_schedule')
    .single();

  if (schemaError || !schemaData) {
    console.error('Error fetching schema metadata:', schemaError);
    return { response: 'Failed to retrieve table schema for flight query.', suggestions: [] };
  }

  const schema_definition = schemaData.schema_json.schema || schemaData.schema_json;
  const sample_data = schemaData.schema_json.sample_data;

  const sample_data_prompt_part = sample_data 
    ? `\nHere is a sample row from the table to give you context on the data format:\n${JSON.stringify(sample_data, null, 2)}\n` 
    : '';

  const today = new Date();
  const year = today.getFullYear();
  const currentDateForPrompt = today.toDateString();

  const sqlGenerationPrompt = `You are an expert AI assistant that translates user questions into SQL queries for a flight database. Your primary goal is to use the provided conversation history to answer follow-up questions accurately.

The schema for the 'public.flight_schedule' table is:
${JSON.stringify(schema_definition, null, 2)}
${sample_data_prompt_part}
**Conversation History:**
${formattedHistory}

**CRITICAL QUERY GENERATION RULES:**
1.  **Analyze User Input:**
    *   Carefully parse the user's latest message to identify an airline code (e.g., "AA", "BA", "DL") and a flight number (e.g., "123", "2490").
    *   The user might provide only a number, only an airline, or both.

2.  **Use the Correct Columns:**
    *   The flight identifier is split into two columns: \`airline_code\` and \`flight_number\`.
    *   You MUST filter on \`airline_code\` for the airline letters and \`flight_number\` for the digits.
    *   Example: For "flight AA123", the query should be \`... WHERE airline_code ILIKE '%AA%' AND flight_number ILIKE '%123%'\`.

3.  **Handle Dates:**
    *   If the user provides a date (e.g., "today", "tomorrow", "July 12th"), you MUST filter the query using the \`origin_date_time\` column.
    *   The current date is **${currentDateForPrompt}**. Use this to resolve relative dates. Assume the current year (${year}) if not specified.
    *   Use a \`DATE()\` function or cast to date to compare only the date part. For example: \`... WHERE DATE(origin_date_time) = '2024-07-12'\`.

4.  **Handle Ambiguous Queries:**
    *   If the user only provides a number like "flight 5018", your query should be \`... WHERE flight_number ILIKE '%5018%'\`. This is correct.
    *   If the user only provides an airline, query by airline.

5.  **Use Context from History:**
    *   For follow-up questions (e.g., "and the gate?"), you MUST look at the conversation history to find the flight number and airline code from a previous message.

6.  **Select the Right Information:**
    *   For **departure** times, query \`scheduled_departure_time\` and \`estimated_departure_time\`.
    *   For **arrival** times, query \`scheduled_arrival_time\` and \`estimated_arrival_time\`.
    *   For **gate** information, query \`gate_name\`.
    *   For flight **status**, query \`operational_status_description\`.

7.  **Safety First:**
    *   Only generate \`SELECT\` statements.
    *   If you cannot construct a valid query, return the single word: \`INVALID_QUERY\`.

**Latest User Question:** "${user_query}"
**SQL Query:**`;

  const generatedText = await callGemini(geminiApiKey, sqlGenerationPrompt);
  let sqlQuery = generatedText.replace(/```sql\n|```/g, '').replace(/;/g, '').trim();
  console.log("Generated SQL:", sqlQuery);

  if (!sqlQuery || sqlQuery.toUpperCase().includes('INVALID_QUERY')) {
    return { response: "I'm sorry, I can't answer that. Could you please rephrase your question with more details?", suggestions: [] };
  }

  const { data, error } = await supabase.rpc('execute_sql_query', { query_text: sqlQuery });

  if (error) {
    console.error('SQL Execution Error:', error);
    return { response: `I'm sorry, I ran into a problem trying to find that information. The query I tried to run was invalid. Please try rephrasing your question.`, suggestions: [] };
  }

  if (data && Array.isArray(data) && data.length > 0) {
    const summarizationPrompt = `You are Mia, a helpful flight assistant. Your task is to provide a clear and direct answer to the user's question based on the database results and conversation history.

**Conversation History:**
${formattedHistory}
**User's Latest Question:** "${user_query}"
**Database Results (JSON):**
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`
**Your Answer:**`;
    
    const summary = await callGemini(geminiApiKey, summarizationPrompt);

    const suggestionGenerationPrompt = `You are a helpful AI assistant. Based on the user's last question and the information you just provided, generate 3-4 short, relevant follow-up questions the user might ask next.

**Conversation History:**
${formattedHistory}
**User's Latest Question:** "${user_query}"
**Your Last Answer:**
"${summary}"
**Database Results (for context):**
${JSON.stringify(data, null, 2)}

**CRITICAL INSTRUCTIONS:**
1.  Generate questions that are natural continuations of the conversation.
2.  Focus on details that were NOT in your last answer. For example, if you just gave the status, suggest asking about the gate, arrival time, or baggage claim.
3.  Keep the questions short and to the point.
4.  Return the suggestions as a JSON array of strings. Example: \`["What's the arrival time?", "Which gate is it at?", "Is it delayed?"]\`
5.  If no relevant suggestions come to mind, return an empty array \`[]\`.
6.  Do not include markdown like \`\`\`json.

**Follow-up Suggestions (JSON Array):**`;

    const suggestionsText = await callGemini(geminiApiKey, suggestionGenerationPrompt);
    let suggestions = [];
    try {
        suggestions = JSON.parse(suggestionsText.trim());
    } catch (e) {
        console.error("Failed to parse suggestions JSON:", suggestionsText, e);
        suggestions = [];
    }

    return { response: summary, suggestions };
  }

  return { response: `I'm sorry, but I couldn't find any information for that query. To help troubleshoot, this is the database query I ran: \`${sqlQuery}\``, suggestions: [] };
}

// Tool 2: General Conversation Logic
async function handleGeneralConversation(geminiApiKey, user_query, formattedHistory) {
  console.log("Inside handleGeneralConversation");
  const prompt = `You are Mia, a friendly and helpful AI assistant for Miami International Airport.
Respond to the user's latest message in a brief, helpful, and conversational way, using the history for context.

**Conversation History:**
${formattedHistory}
**User's Latest Message:** "${user_query}"
**Your Response:**`;
  const response = await callGemini(geminiApiKey, prompt);
  return { response, suggestions: [] };
}

// Main Server Logic (The Agent/Router)
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

    const intentClassificationPrompt = `You are a router agent. Your job is to classify the user's latest intent.
Respond with one of the following tool names:
- 'FLIGHT_QUERY': If the user is asking about flights, delays, terminals, gates, airlines, or a short follow-up question related to a previous flight query.
- 'GENERAL_CONVERSATION': If the user is making small talk, greeting, or asking a question not related to flights.

**Conversation History:**
${formattedHistory}
**User's Latest Message:** "${user_query}"
**Tool:**`;

    const rawIntent = await callGemini(geminiApiKey, intentClassificationPrompt);
    const intent = rawIntent.trim().toUpperCase().replace(/['".]/g, "");
    console.log("Cleaned Intent:", intent);

    let result;

    if (intent.includes('FLIGHT_QUERY')) {
      console.log("Routing to FLIGHT_QUERY tool.");
      result = await handleFlightQuery(supabase, geminiApiKey, user_query, formattedHistory);
    } else {
      console.log("Routing to GENERAL_CONVERSATION tool.");
      result = await handleGeneralConversation(geminiApiKey, user_query, formattedHistory);
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