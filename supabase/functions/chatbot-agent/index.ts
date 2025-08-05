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
    throw new Error('Failed to retrieve table schema for flight query.');
  }

  const schema_definition = schemaData.schema_json.schema || schemaData.schema_json;
  const sample_data = schemaData.schema_json.sample_data;

  const sample_data_prompt_part = sample_data 
    ? `\nHere is a sample row from the table to give you context on the data format:\n${JSON.stringify(sample_data, null, 2)}\n` 
    : '';

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

3.  **Handle Ambiguous Queries:**
    *   If the user only provides a number like "flight 5018", your query should be \`... WHERE flight_number ILIKE '%5018%'\`. This is correct.
    *   If the user only provides an airline, query by airline.

4.  **Use Context from History:**
    *   For follow-up questions (e.g., "and the gate?"), you MUST look at the conversation history to find the flight number and airline code from a previous message.

5.  **Select the Right Information:**
    *   For **departure** times, query \`scheduled_departure_time\` and \`estimated_departure_time\`.
    *   For **arrival** times, query \`scheduled_arrival_time\` and \`estimated_arrival_time\`.
    *   For **gate** information, query \`gate_name\`.
    *   For flight **status**, query \`operational_status_description\`.

6.  **Safety First:**
    *   Only generate \`SELECT\` statements.
    *   If you cannot construct a valid query, return the single word: \`INVALID_QUERY\`.

**Example 1: Full Flight ID**
*   History: (empty)
*   Latest User Question: "What is the departure time for flight DL456?"
*   Your SQL Query: \`SELECT scheduled_departure_time, estimated_departure_time FROM public.flight_schedule WHERE airline_code ILIKE '%DL%' AND flight_number ILIKE '%456%'\`

**Example 2: Number Only**
*   History: (empty)
*   Latest User Question: "What is the status of flight 5018?"
*   Your SQL Query: \`SELECT operational_status_description FROM public.flight_schedule WHERE flight_number ILIKE '%5018%'\`

**Example 3: Follow-up Question**
*   History: \`User: What's the status of flight AA123? \\n Assistant: Flight AA123 is on time.\`
*   Latest User Question: "and what time does it land?"
*   Your SQL Query: \`SELECT scheduled_arrival_time, estimated_arrival_time FROM public.flight_schedule WHERE airline_code ILIKE '%AA%' AND flight_number ILIKE '%123%'\`

**Latest User Question:** "${user_query}"
**SQL Query:**`;

  console.log("Generating SQL query...");
  const generatedText = await callGemini(geminiApiKey, sqlGenerationPrompt);
  let sqlQuery = generatedText.replace(/```sql\n|```/g, '').replace(/;/g, '').trim();
  console.log("Generated SQL:", sqlQuery);

  if (!sqlQuery || sqlQuery.toUpperCase().includes('INVALID_QUERY')) {
    console.log("Generated query was invalid or empty.");
    return "I'm sorry, I can't answer that. Could you please rephrase your question with more details?";
  }

  console.log("Executing SQL query...");
  const { data, error } = await supabase.rpc('execute_sql_query', { query_text: sqlQuery });

  if (error) {
    console.error('SQL Execution Error:', error);
    return `I'm sorry, I ran into a problem trying to find that information. The query I tried to run was invalid. Please try rephrasing your question.`;
  }

  console.log("SQL query successful. Data:", data);

  if (data && Array.isArray(data) && data.length > 0) {
    const summarizationPrompt = `You are Mia, a helpful flight assistant. Your task is to provide a clear and direct answer to the user's question based on the database results and conversation history.

**Conversation History:**
${formattedHistory}

**User's Latest Question:** "${user_query}"

**Database Results (JSON):**
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

**CRITICAL INSTRUCTIONS:**
1.  **Directly Answer the Question:** Use the "Database Results" to directly answer the "User's Latest Question".
2.  **Use Context:** Refer to the "Conversation History" to understand the full context, especially for follow-up questions.
3.  **Be Concise:** Provide a short, natural language response. Do not just repeat the JSON data.
4.  **Handle No Data:** If the database results are empty, state that you couldn't find the information.
5.  **Example:** If the user asked "what time does it land?" and the data is \`[{"actual_arrival_time": "2024-08-20T14:30:00"}]\`, a good response is "The flight landed at 2:30 PM."

**Your Answer:**`;
    console.log("Summarizing result...");
    return await callGemini(geminiApiKey, summarizationPrompt);
  }

  console.log("No data found for the query.");
  return `I'm sorry, but I couldn't find any information for that query. To help troubleshoot, this is the database query I ran: \`${sqlQuery}\``;
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
  return await callGemini(geminiApiKey, prompt);
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

    // 1. Intent Classification
    const intentClassificationPrompt = `You are a router agent. Your job is to classify the user's latest intent based on the.
Respond with one of the following tool names:
- 'FLIGHT_QUERY': If the user is asking about flights, delays, terminals, gates, airlines, or a short follow-up question related to a previous flight query.
- 'GENERAL_CONVERSATION': If the user is making small talk, greeting, or asking a question not related to flights.

**Conversation History:**
${formattedHistory}

**User's Latest Message:** "${user_query}"
**Tool:**`;

    const rawIntent = await callGemini(geminiApiKey, intentClassificationPrompt);
    const intent = rawIntent.trim().toUpperCase().replace(/['".]/g, ""); // Clean and normalize
    console.log("Raw Intent from Model:", rawIntent);
    console.log("Cleaned Intent:", intent);

    let response;

    // 2. Tool Routing
    if (intent.includes('FLIGHT_QUERY')) {
      console.log("Routing to FLIGHT_QUERY tool.");
      response = await handleFlightQuery(supabase, geminiApiKey, user_query, formattedHistory);
    } else if (intent.includes('GENERAL_CONVERSATION')) {
      console.log("Routing to GENERAL_CONVERSATION tool.");
      response = await handleGeneralConversation(geminiApiKey, user_query, formattedHistory);
    } else {
      console.log(`Fallback: Could not classify intent '${intent}'. Trying general conversation.`);
      response = await handleGeneralConversation(geminiApiKey, user_query, formattedHistory);
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