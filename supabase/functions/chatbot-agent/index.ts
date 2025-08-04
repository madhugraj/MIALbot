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

// Tool 1: Flight Query Logic
async function handleFlightQuery(supabase, geminiApiKey, user_query) {
  const { data: schemaData, error: schemaError } = await supabase
    .from('schema_metadata')
    .select('schema_json')
    .eq('table_name', 'flight_schedule')
    .single();

  if (schemaError || !schemaData) {
    console.error('Error fetching schema metadata:', schemaError);
    throw new Error('Failed to retrieve table schema for flight query.');
  }

  const sqlGenerationPrompt = `You are an AI agent responsible for answering user questions using data from the \`public.flight_schedule\` table in PostgreSQL.
You must convert each user message into a safe, read-only SQL SELECT query.
The schema for the 'public.flight_schedule' table is:
${JSON.stringify(schemaData.schema_json)}
**Rules & Guidelines:**
✔️ Only use the table \`public.flight_schedule\`.
✔️ Never modify, insert, delete, or update data.
✔️ Prefer selecting these columns: flight_number, airline_name, departure_airport_name, arrival_airport_name, scheduled_departure_time, estimated_departure_time, actual_departure_time, terminal_name, gate_name, operational_status_description.
✔️ Use fuzzy search with ILIKE for city or airport names (e.g., departure_airport_name ILIKE '%mumbai%').
✔️ If the user's question implies a date or time, always order the results by scheduled_departure_time in descending order (DESC).
✔️ If a query is impossible or ambiguous, you MUST return the single word: INVALID_QUERY.
**Only return SQL — no explanation or commentary.**
**User Question:** "${user_query}"
**SQL Query:**`;

  const generatedText = await callGemini(geminiApiKey, sqlGenerationPrompt);
  let sqlQuery = generatedText.replace(/```sql\n|```/g, '').replace(/;/g, '').trim();

  if (!sqlQuery || sqlQuery.toUpperCase() === 'INVALID_QUERY') {
    return "I couldn't generate a SQL query for that request. Please try rephrasing your question or ask about flight schedules, delays, or counts.";
  }

  const { data, error } = await supabase.rpc('execute_sql_query', { query_text: sqlQuery });

  if (error) {
    console.error('SQL Execution Error:', error);
    return `I'm sorry, I ran into a problem trying to find that information. The query I tried to run was invalid. Please try rephrasing your question.`;
  }

  if (data && Array.isArray(data) && data.length > 0) {
    const summarizationPrompt = `You are a helpful flight assistant. A user asked: "${user_query}".
The following data was retrieved from the database in JSON format:
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`
Based on this data, provide a concise, natural language answer. Do not just list the data. Summarize it in a friendly and helpful way. If the data contains a count, state it clearly.`;
    return await callGemini(geminiApiKey, summarizationPrompt);
  }

  return "I couldn't find any data matching your query.";
}

// Tool 2: General Conversation Logic
async function handleGeneralConversation(geminiApiKey, user_query) {
  const prompt = `You are MIAlAssist, a friendly and helpful AI assistant for Miami International Airport.
The user said: "${user_query}"
Provide a brief, helpful, and conversational response. Keep it concise. If you don't know the answer, say so politely.`;
  return await callGemini(geminiApiKey, prompt);
}

// Main Server Logic (The Agent/Router)
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { user_query } = await req.json();
    const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
    if (!geminiApiKey) throw new Error('GEMINI_API_KEY is not set.');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );

    // 1. Intent Classification
    const intentClassificationPrompt = `You are a router agent. Your job is to classify the user's intent.
Based on the user's message, determine if they are asking a question about flight schedules or if they are making general conversation.
Respond with one of the following tool names:
- 'FLIGHT_QUERY': If the user is asking about flights, delays, terminals, gates, airlines, etc.
- 'GENERAL_CONVERSATION': If the user is making small talk, greeting, or asking a question not related to flights.
User Message: "${user_query}"
Tool:`;

    const intent = (await callGemini(geminiApiKey, intentClassificationPrompt)).trim().replace(/'/g, "");
    console.log("Classified Intent:", intent);

    let response;

    // 2. Tool Routing
    if (intent === 'FLIGHT_QUERY') {
      response = await handleFlightQuery(supabase, geminiApiKey, user_query);
    } else if (intent === 'GENERAL_CONVERSATION') {
      response = await handleGeneralConversation(geminiApiKey, user_query);
    } else {
      // Fallback if classification fails or is unexpected
      console.log("Fallback: Could not classify intent. Trying general conversation.");
      response = await handleGeneralConversation(geminiApiKey, user_query);
    }

    return new Response(JSON.stringify({ response }), {
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