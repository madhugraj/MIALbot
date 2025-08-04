import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Define the schema for the flight_schedule table to guide the LLM
const FLIGHT_SCHEDULE_SCHEMA = `
CREATE TABLE public.flight_schedule (
  flight_schedule_id BIGINT NOT NULL,
  aodb_flight_id BIGINT,
  airline_code VARCHAR,
  flight_number VARCHAR,
  flight_schedule_type VARCHAR,
  flight_type VARCHAR,
  operational_suffix VARCHAR,
  operational_status VARCHAR,
  code_context VARCHAR,
  departure_airport VARCHAR,
  arrival_airport VARCHAR,
  schedule_type VARCHAR,
  terminal_name VARCHAR,
  public_terminal_name VARCHAR,
  origin_date_time TIMESTAMP WITHOUT TIME ZONE,
  scheduled_arrival_time TIMESTAMP WITHOUT TIME ZONE,
  estimated_arrival_time TIMESTAMP WITHOUT TIME ZONE,
  actual_arrival_time TIMESTAMP WITHOUT TIME ZONE,
  scheduled_departure_time TIMESTAMP WITHOUT TIME ZONE,
  estimated_departure_time TIMESTAMP WITHOUT TIME ZONE,
  actual_departure_time TIMESTAMP WITHOUT TIME ZONE,
  final_boarding_time TIMESTAMP WITHOUT TIME ZONE,
  boarding_time TIMESTAMP WITHOUT TIME ZONE,
  actual_touchdown_time TIMESTAMP WITHOUT TIME ZONE,
  actual_take_off_time TIMESTAMP WITHOUT TIME ZONE,
  first_bag_unloaded_time TIMESTAMP WITHOUT TIME ZONE,
  last_bag_unloaded_time TIMESTAMP WITHOUT TIME ZONE,
  gate_open_time TIMESTAMP WITHOUT TIME ZONE,
  gate_close_time TIMESTAMP WITHOUT TIME ZONE,
  ten_miles_out_time TIMESTAMP WITHOUT TIME ZONE,
  stand_bay VARCHAR,
  service_type VARCHAR,
  special_action VARCHAR,
  delay_code VARCHAR,
  delay_duration INTERVAL,
  remark_text_code VARCHAR,
  remark_free_text TEXT,
  created_by VARCHAR,
  created_dt TIMESTAMP WITHOUT TIME ZONE,
  updated_by VARCHAR,
  updated_dt TIMESTAMP WITHOUT TIME ZONE,
  airline_name VARCHAR,
  departure_airport_name VARCHAR,
  arrival_airport_name VARCHAR,
  deleted_dt TIMESTAMP WITHOUT TIME ZONE,
  operational_status_description VARCHAR,
  gate_name VARCHAR,
  service_type_desc VARCHAR
);
`;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { user_query } = await req.json();
    console.log("User Query:", user_query);

    const geminiApiKey = Deno.env.get('GEMINI_API_KEY');

    if (!geminiApiKey) {
      console.error('GEMINI_API_KEY is not set in Supabase secrets.');
      throw new Error('GEMINI_API_KEY is not set in Supabase secrets.');
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { 'x-my-custom-header': 'Supabase-Edge-Function' },
        },
      }
    );

    let sqlQuery = '';
    let naturalLanguageResponse = '';

    const prompt = `You are a PostgreSQL query generator. Given the following table schema for 'flight_schedule':
\`\`\`sql
${FLIGHT_SCHEDULE_SCHEMA}
\`\`\`
Generate a PostgreSQL query based on the user's request. Only output the SQL query, nothing else. Do not include any explanations or additional text.
If the request cannot be fulfilled with the given schema, return an empty string.

User request: "${user_query}"`;

    console.log("Prompt sent to Gemini:", prompt);

    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${geminiApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }]
      }),
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      console.error(`Gemini API error: ${geminiResponse.status} - ${errorText}`);
      throw new Error(`Failed to get response from Gemini API: ${geminiResponse.statusText}`);
    }

    const geminiData = await geminiResponse.json();
    console.log("Raw Gemini Response:", JSON.stringify(geminiData, null, 2));
    
    if (geminiData.candidates && geminiData.candidates.length > 0 && geminiData.candidates[0].content && geminiData.candidates[0].content.parts && geminiData.candidates[0].content.parts.length > 0) {
      const generatedText = geminiData.candidates[0].content.parts[0].text;
      console.log("Generated Text from Gemini:", generatedText);
      
      const sqlMatch = generatedText.match(/```sql\n([\s\S]*?)\n```/);
      if (sqlMatch && sqlMatch[1]) {
        sqlQuery = sqlMatch[1].trim();
        console.log("Extracted SQL from markdown:", sqlQuery);
      } else {
        sqlQuery = generatedText.trim();
        console.log("Assuming entire response is SQL:", sqlQuery);
      }
    } else {
      console.warn("Gemini response did not contain expected content structure.");
    }

    if (sqlQuery) {
      console.log("Final SQL Query to execute:", sqlQuery);
      const { data, error } = await supabase.rpc('execute_sql_query', { query_text: sqlQuery });

      if (error) {
        console.error('SQL Execution Error:', error);
        naturalLanguageResponse = `I encountered an error while fetching data: ${error.message}.`;
      } else if (data) {
        console.log("SQL Query Result Data:", JSON.stringify(data, null, 2));
        if (Array.isArray(data) && data.length > 0) {
          naturalLanguageResponse = "Here are the results:\n\n";
          data.forEach((row: any) => {
            naturalLanguageResponse += Object.entries(row).map(([key, value]) => `${key}: ${value}`).join(', ') + '.\n';
          });
        } else if (typeof data === 'object' && data !== null && 'count' in data) {
          naturalLanguageResponse = `The count is: ${data.count}.`;
        } else {
          naturalLanguageResponse = "No specific data found matching your query, but the query executed successfully.";
        }
      } else {
        naturalLanguageResponse = "No data received from the query.";
      }
    } else {
      naturalLanguageResponse = "I couldn't generate a SQL query for that request. Please try rephrasing your question or ask about flight schedules, delays, or counts.";
    }

    return new Response(JSON.stringify({ response: naturalLanguageResponse }), {
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