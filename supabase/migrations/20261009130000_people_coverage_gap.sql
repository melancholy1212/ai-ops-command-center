-- A company with no established decision maker is a coverage gap (docs/domain-model.md: person.current_role is
-- required per person). The gap is recorded at company level: no person exists to attach it to.
alter table public.research_gaps drop constraint research_gaps_attribute_check;
alter table public.research_gaps add constraint research_gaps_attribute_check
  check (attribute like 'company.%' or attribute = 'person.current_role');
