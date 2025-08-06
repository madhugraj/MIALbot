import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper to call the Gemini API
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


// Helper to format history
function formatHistory(history) {
    if (!history || history.length === 0) return "No conversation history yet.";
    return history.map(msg => `${msg.sender === 'user' ? 'User' : 'Assistant'}: ${msg.text}`).join('\n');
}

// Tool 1: Database Query via Text-to-SQL (Improved)
async function handleDatabaseQuery(supabase, geminiApiKey, user_query, formattedHistory) {
  console.log("Inside handleDatabaseQuery (Text-to-SQL)");

  // 1. Fetch the database schema
  const { data: schemaData, error: schemaError } = await supabase
    .from('schema_metadata')
    .select('schema_json')
    .eq('table_name', 'flight_schedule')
    .single();

  if (schemaError || !schemaData) {
    console.error('Schema Fetch Error:', schemaError);
    return { response: "I'm sorry, I can't access my knowledge base right now. Please try again later.", suggestions: [], generatedSql: null };
  }
  const schemaDefinition = JSON.stringify(schemaData.schema_json, null, 2);

  // 2. Generate SQL from user query
  const sqlGenerationPrompt = `You are an expert PostgreSQL assistant. Your task is to generate a SQL query to answer the user's question based on the provided database schema and conversation history.

**Database Schema for 'flight_schedule' table:**
${schemaDefinition}

**Conversation History:**
${formattedHistory}

**User's Latest Question:** "${user_query}"

**CRITICAL INSTRUCTIONS:**
1.  **Generate a single, valid PostgreSQL query.**
2.  The current date is ${new Date().toISOString().split('T')[0]}. Use this for queries about "today" or "tonight".
3.  Use the \`ILIKE\` operator with wildcards (\`%\`) for case-insensitive text matching on columns like \`airline_code\`, \`flight_number\`, \`departure_airport_name\`, and \`arrival_airport_name\`. For example, to find flight 'AA123', use \`WHERE flight_number ILIKE '%AA123%'\`.
4.  Select columns that are most relevant to the user's question. If they ask about a gate, select \`gate_name\`. If they ask about delays, select \`delay_duration\`. For a general status query, select key fields like \`operational_status_description\`, \`scheduled_departure_time\`, \`scheduled_arrival_time\`, and \`gate_name\`. Always include the airline and flight number for context.
5.  **DO NOT** use markdown (\`\`\`sql\`) or any other text, just the raw SQL query.

**SQL Query:`;

  const generatedSql = (await callGemini(geminiApiKey, sqlGenerationPrompt)).replace(/```sql\n|```/g, '').trim();
  console.log("Generated SQL:", generatedSql);

  if (!generatedSql || !generatedSql.toUpperCase().startsWith('SELECT')) {
      console.error("SQL Generation Failed. Response:", generatedSql);
      return { response: "I'm sorry, I had trouble understanding how to find that information. Could you rephrase your question?", suggestions: [], generatedSql: generatedSql || "Failed to generate SQL." };
  }

  // 3. Execute the generated SQL
  const { data: queryResult, error: queryError } = await supabase.rpc('execute_sql_query', {
    query_text: generatedSql
  });

  if (queryError) {
    console.error('SQL Execution Error:', queryError);
    return { response: `I'm sorry, I ran into a database error.`, suggestions: [], generatedSql };
  }

  // 4. Summarize the result
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

    // 5. Generate suggestions
    const suggestionGenerationPrompt = `You are an expert AI assistant that generates relevant follow-up questions for a user inquiring about flight information. Your suggestions MUST be answerable using ONLY the provided database schema.

**Database Schema for 'flight_schedule' table:**
${schemaDefinition}

**Conversation Context:**
*   **History:** ${formattedHistory}
*   **User's Latest Question:** "${user_query}"
*   **Your Last Answer:** "${summary}"
*   **Data Used for Answer:** ${JSON.stringify(queryResult, null, 2)}

**CRITICAL INSTRUCTIONS:**
1.  **Schema-Bound:** Generate questions that can be answered using the columns in the schema.
2.  **Contextual & Relevant:** The questions should be a natural continuation of the conversation and focus on details NOT already provided in "Your Last Answer".
3.  **Format:** Return a JSON array of 3-4 short, to-the-point questions. Example: \`["What's the arrival time?", "Which gate is it at?"]\`
4.  **No Markdown:** Do not include markdown like \`\`\`json.

**Follow-up Suggestions (JSON Array):**`;

    const suggestionsText = await callGemini(geminiApiKey, suggestionGenerationPrompt);
    let suggestions = [];
    try {
        suggestions = JSON.parse(suggestionsText.replace(/```json\n|```/g, '').trim());
    } catch (e) {
        console.error("Failed to parse suggestions JSON:", suggestionsText, e);
        suggestions = []; // Default to empty array on failure
    }

    return { response: summary, suggestions, generatedSql };
  }

  // Handle no results found
  return { response: `I couldn't find any information for your query. Please try rephrasing your question.`, suggestions: ["Is flight AA 100 on time?", "What is the status of flight DL 200?", "Which gate is flight UA 300 departing from?"], generatedSql };
}

// Tool 2: General Conversation Logic
async function handleGeneralConversation(geminiApiKey, user_query, formattedHistory) {
  console.log("Inside handleGeneralConversation");
  const prompt = `You are Mia, a friendly and helpful AI assistant for Miami International Airport.
Respond to the user's latest message in a brief, helpful, and conversational way, using the history for context.

**Conversation History:**
${formattedHistory}
**User's Latest Message:** "${user_query}"
**Your Response:`;
  const response = await callGemini(geminiApiKey, prompt);
  return { response, suggestions: ["What's the status of flight AA123?", "Where is the Admirals Club?", "How long is the security wait?"], generatedSql: null };
}

// New Tool: Structured Flight Search using RPC
async function handleStructuredSearch(supabase, geminiApiKey, searchParams) {
  console.log("Inside handleStructuredSearch (RPC)");
  const { airlineCode, flightNumber, date } = searchParams;

  // 1. Call the get_flight_info RPC function
  const { data: queryResult, error: queryError } = await supabase.rpc('get_flight_info', {
    p_airline_code: airlineCode || null,
    p_flight_number: flightNumber || null,
    p_origin_date: date ? new Date(date).toISOString().split('T')[0] : null
  });

  if (queryError) {
    console.error('RPC Execution Error:', queryError);
    return { response: `I'm sorry, I ran into a database error while searching.`, suggestions: [], generatedSql: `RPC Call: get_flight_info with params: ${JSON.stringify(searchParams)}` };
  }

  // 2. Summarize the result
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

    // 3. Generate suggestions
    const { data: schemaData } = await supabase
      .from('schema_metadata')
      .select('schema_json')
      .eq('table_name', 'flight_schedule')
      .single();
    const schemaDefinition = JSON.stringify(schemaData?.schema_json, null, 2) || "{}";

    const suggestionGenerationPrompt = `You are an expert AI assistant that generates relevant follow-up questions for a user inquiring about flight information. Your suggestions MUST be answerable using ONLY the provided database schema.

**Database Schema for 'flight_schedule' table:**
${schemaDefinition}

**Conversation Context:**
*   **User's Search:** ${JSON.stringify(searchParams)}
*   **Your Last Answer:** "${summary}"
*   **Data Used for Answer:** ${JSON.stringify(queryResult, null, 2)}

**CRITICAL INSTRUCTIONS:**
1.  **Schema-Bound:** Generate questions that can be answered using the columns in the schema.
2.  **Contextual & Relevant:** The questions should be a natural continuation of the conversation and focus on details NOT already provided in "Your Last Answer".
3.  **Format:** Return a JSON array of 3-4 short, to-the-point questions. Example: \`["What's the arrival time?", "Which gate is it at?"]\`
4.  **No Markdown:** Do not include markdown like \`\`\`json.

**Follow-up Suggestions (JSON Array):**`;

    const suggestionsText = await callGemini(geminiApiKey, suggestionGenerationPrompt);
    let suggestions = [];
    try {
        suggestions = JSON.parse(suggestionsText.replace(/```json\n|```/g, '').trim());
    } catch (e) {
        console.error("Failed to parse suggestions JSON:", suggestionsText, e);
        suggestions = [];
    }

    return { response: summary, suggestions, generatedSql: `RPC: get_flight_info(${JSON.stringify(searchParams, null, 2)})` };
  }

  // Handle no results found
  return { response: `I couldn't find any flight information for your search. Please check the details and try again.`, suggestions: [], generatedSql: `RPC Call: get_flight_info with params: ${JSON.stringify(searchParams)}` };
}

// Main Server Logic (The Agent/Router)
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
      const formattedHistory = formatHistory(history);
      const intentClassificationPrompt = `You are a router agent. Your job is to classify the user's latest intent.
Respond with one of the following tool names:
- 'DATABASE_QUERY': If the user is asking about flights, delays, terminals, gates, airlines, arrival/departure times, or any specific airport information that would be in a database.
- 'GENERAL_CONVERSATION': If the user is making small talk, greeting, saying thank you, or asking a question not related to specific flight/airport data.

**Conversation History:**
${formattedHistory}
**User's Latest Message:** "${user_query}"
**Tool:`;

      const rawIntent = await callGemini(geminiApiKey, intentClassificationPrompt);
      const intent = rawIntent.trim().toUpperCase().replace(/['".]/g, "");
      console.log("Cleaned Intent:", intent);

      if (intent.includes('DATABASE_QUERY')) {
        console.log("Routing to DATABASE_QUERY tool.");
        result = await handleDatabaseQuery(supabase, geminiApiKey, user_query, formattedHistory);
      } else {
        console.log("Routing to GENERAL_CONVERSATION tool.");
        result = await handleGeneralConversation(geminiApiKey, user_query, formattedHistory);
      }
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