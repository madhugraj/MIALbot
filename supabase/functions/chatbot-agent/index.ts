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

  const sqlGenerationPrompt = `You are an expert AI assistant that translates user questions into SQL queries for a flight database. Your primary goal is to use the provided conversation history to answer follow-up questions accurately.

The schema for the 'public.flight_schedule' table is:
${JSON.stringify(schemaData.schema_json)}

**Conversation History:**
${formattedHistory}

**CRITICAL INSTRUCTIONS:**
1.  **Prioritize Context:** The user's latest message might be a short follow-up (e.g., "what time?", "and the gate?"). ALWAYS check the conversation history to understand the full context and find the relevant flight number or airport.
2.  **Infer from History:** Use entities (like flight numbers, dates, or airports) from previous turns to complete the current query.
3.  **Be Specific:** When a user asks about landing/arrival, use \`actual_arrival_time\` or \`estimated_arrival_time\`. For departure, use \`scheduled_departure_time\` or \`estimated_departure_time\`.
4.  **Safe Queries Only:** Only generate \`SELECT\` statements. Never \`UPDATE\`, \`DELETE\`, or \`INSERT\`.
5.  **Invalid Queries:** If you cannot construct a meaningful query from the user's message and the history, return the single word: INVALID_QUERY.

**Example 1: Follow-up on Status**
*   History: \`User: What's the status of flight AA123? \\n Assistant: Flight AA123 is on time, scheduled to arrive at Gate C5.\`
*   Latest User Question: "and what time does it land?"
*   Your SQL Query: \`SELECT estimated_arrival_time, actual_arrival_time FROM public.flight_schedule WHERE flight_number ILIKE '%AA123%'\`

**Example 2: Follow-up on Terminal**
*   History: \`User: which terminal did flight BA2490 reach? \\n Assistant: Flight BA2490 arrived at Terminal 3.\`
*   Latest User Question: "what time?"
*   Your SQL Query: \`SELECT actual_arrival_time FROM public.flight_schedule WHERE flight_number ILIKE '%BA2490%'\`

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
  return "I couldn't find any data matching your query.";
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