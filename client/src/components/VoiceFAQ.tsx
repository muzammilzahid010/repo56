import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { HelpCircle } from "lucide-react";

export default function VoiceFAQ() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-voice-faq">
          <HelpCircle className="w-4 h-4 mr-2" />
          FAQ
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Voice Generation FAQ</DialogTitle>
        </DialogHeader>
        
        <Accordion type="single" collapsible className="w-full">
          <AccordionItem value="cloning">
            <AccordionTrigger className="text-left">
              1. Voice Cloning Issues
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-3 text-muted-foreground">
                <p className="font-medium text-foreground">Why isn't my voice properly cloned?</p>
                <ul className="list-disc pl-5 space-y-2">
                  <li>Speak loudly, clearly, and with inflection. Avoid monotone speech patterns for better results.</li>
                  <li>Use a high-quality microphone when available to ensure clean audio input.</li>
                  <li>Make sure uploaded voice clips have clear audio, no background noise, and no audio artifacts (hissing, high pitched noises, etc.)</li>
                </ul>
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="generation">
            <AccordionTrigger className="text-left">
              2. Generation Issues
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-3 text-muted-foreground">
                <p className="font-medium text-foreground">Why is my generation bad?</p>
                <p>Quality may vary across speakers and generations, but here are some things to consider:</p>
                <ul className="list-disc pl-5 space-y-2">
                  <li>Make sure your recorded or uploaded voice clips are of high quality.</li>
                  <li>Make sure all your text is spelled correctly, or phonetically if using an obscure word, and is written in the language you are generating in.</li>
                </ul>
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="language">
            <AccordionTrigger className="text-left">
              3. Language Support
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-3 text-muted-foreground">
                <p className="font-medium text-foreground">Which languages are supported?</p>
                <p>Our model primarily supports English, with strong capabilities in:</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Mandarin (Chinese)</li>
                  <li>Japanese</li>
                  <li>Korean</li>
                  <li>French</li>
                  <li>German</li>
                </ul>
                <p className="mt-3 italic">
                  Cloned voices perform best when the speaker in the original clip is speaking in the language you want to generate in. For example, cloning a clip of someone speaking English will work best for generating English speech.
                </p>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </DialogContent>
    </Dialog>
  );
}
