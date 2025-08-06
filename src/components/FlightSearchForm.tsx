"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { format } from "date-fns";
import { CalendarIcon, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const formSchema = z.object({
  airlineCode: z.string().optional(),
  flightNumber: z.string().optional(),
  date: z.date().optional(),
}).refine(
  (data) => !!data.airlineCode || !!data.flightNumber || !!data.date,
  {
    message: "Please fill at least one search field to begin.",
    path: ["airlineCode"], // Shows the error message under the first field for simplicity
  }
);

export type FlightSearchFormValues = z.infer<typeof formSchema>;

interface FlightSearchFormProps {
  onSearch: (data: FlightSearchFormValues) => void;
  isSearching: boolean;
}

export function FlightSearchForm({ onSearch, isSearching }: FlightSearchFormProps) {
  const form = useForm<FlightSearchFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      airlineCode: "",
      flightNumber: "",
    },
  });

  function onSubmit(data: FlightSearchFormValues) {
    onSearch(data);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 p-4 border-b">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="airlineCode"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Airline Code (Optional)</FormLabel>
                <FormControl>
                  <Input placeholder="e.g., BA, AA" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="flightNumber"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Flight Number (Optional)</FormLabel>
                <FormControl>
                  <Input placeholder="e.g., 209" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="date"
          render={({ field }) => (
            <FormItem className="flex flex-col">
              <FormLabel>Date of Departure (Optional)</FormLabel>
              <Popover>
                <PopoverTrigger asChild>
                  <FormControl>
                    <Button
                      variant={"outline"}
                      className={cn(
                        "w-full pl-3 text-left font-normal",
                        !field.value && "text-muted-foreground"
                      )}
                    >
                      {field.value ? (
                        format(field.value, "PPP")
                      ) : (
                        <span>Pick a date</span>
                      )}
                      <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                    </Button>
                  </FormControl>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={field.value}
                    onSelect={field.onChange}
                    disabled={(date) =>
                      date > new Date() || date < new Date("1900-01-01")
                    }
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="w-full" disabled={isSearching}>
          <Search className="mr-2 h-4 w-4" />
          {isSearching ? "Searching..." : "Search Flight"}
        </Button>
      </form>
    </Form>
  );
}