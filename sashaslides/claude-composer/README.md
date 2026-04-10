# Important

This project contains a composer experiment which claude code is performing. We are going to discover optimal way to work with slides API.

## Code style
* Before reporting success always make sure you add tests, run tests E2E and unit tests.
* Always use immutable values: `Readonly<{ x: number; y: number; subField: SubFieldType }>` (`SubFieldType` is also `Readonly`)
* Use files to group functions, one file per immutable type and functions associated with it.
* As you are working update ARCHITECTURE.md doc with the latest high level information.
* At the end of ARCHITECTURE.md.
* Automate everything you can. Instead of explaning how to run something, write claude skill which references running a script to do the work. Put the script with the same name like the skill and just different extension near the skill to improve local reasoning. Then the skill should be implemented in typescript inside of sashaslides/claude-composer.

## Functionalty

You need to be able to create slides based on some similar slides from the past presentations. You will need to design content of the slides, check the result and iterate until they look ok. For this purpose you have chrome instance, I'll log with my account and you will also be able to see the slides. Find a way (javascript) to screenshot all slides and then be able to see what's the result.

We will need to design a generic architecture how to do this. Investigate first online how to best use claude to create slides and how to make claude an artist. It's uncler what format is easiest for claude.  Maybe Google slides will be tool limited and we'll design HTML instead and then somehow convert into pictures.

You will definitely need to understand graphically what is approximately desired and low bar, but if you can do better do it.

The presentation styles need to be consistent. The general idea is:
* You will be given markdown content which depicts slides.
* You will find the closes template slide which fits.
* Then you will adapt the template slide.

The next step would be then to automate this by using some small open source models, but let's try this proof of concept, just working with slides api and visually converge.