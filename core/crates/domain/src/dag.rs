use std::collections::HashMap;

use crate::{DomainError, Id};

/// `task_id` cannot start before `depends_on_task_id` finishes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DependencyEdge {
    pub task_id: Id,
    pub depends_on_task_id: Id,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mark {
    Unvisited,
    OnPath,
    Finished,
}

/// Checks that the dependency edges form a directed acyclic graph.
///
/// A port of `assertAcyclic` in `packages/domain/src/dag.ts`: an iterative
/// depth-first search that visits nodes and neighbours in first-appearance
/// order, so the reported cycle is the same one the TypeScript core reports.
/// A self-dependency is a cycle of length one.
pub fn assert_acyclic(edges: &[DependencyEdge]) -> Result<(), DomainError> {
    let mut index_of: HashMap<&Id, usize> = HashMap::new();
    let mut nodes: Vec<&Id> = Vec::new();
    let mut neighbours: Vec<Vec<usize>> = Vec::new();
    let mut intern = |id| {
        *index_of.entry(id).or_insert_with(|| {
            nodes.push(id);
            neighbours.push(Vec::new());
            nodes.len() - 1
        })
    };
    let mut pairs = Vec::with_capacity(edges.len());
    for edge in edges {
        let from = intern(&edge.task_id);
        let to = intern(&edge.depends_on_task_id);
        pairs.push((from, to));
    }
    for (from, to) in pairs {
        neighbours[from].push(to);
    }

    let mut marks = vec![Mark::Unvisited; nodes.len()];
    for start in 0..nodes.len() {
        if marks[start] != Mark::Unvisited {
            continue;
        }
        // Each frame is (node, index of the next neighbour to look at).
        let mut stack: Vec<(usize, usize)> = vec![(start, 0)];
        let mut path: Vec<usize> = vec![start];
        marks[start] = Mark::OnPath;
        while let Some(frame) = stack.last_mut() {
            let (node, next_index) = *frame;
            let Some(&next) = neighbours[node].get(next_index) else {
                marks[node] = Mark::Finished;
                stack.pop();
                path.pop();
                continue;
            };
            frame.1 += 1;
            match marks[next] {
                Mark::OnPath => {
                    let cycle_start = path.iter().position(|&entry| entry == next).unwrap_or(0);
                    let mut cycle: Vec<Id> =
                        path[cycle_start..].iter().map(|&entry| nodes[entry].clone()).collect();
                    cycle.push(nodes[next].clone());
                    return Err(DomainError::DependencyCycle(cycle));
                }
                Mark::Unvisited => {
                    marks[next] = Mark::OnPath;
                    path.push(next);
                    stack.push((next, 0));
                }
                Mark::Finished => {}
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(last: char) -> Id {
        Id::parse(&format!("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c5{last}")).unwrap()
    }

    fn edge(task: char, depends_on: char) -> DependencyEdge {
        DependencyEdge { task_id: id(task), depends_on_task_id: id(depends_on) }
    }

    #[test]
    fn chains_diamonds_and_empty_graphs_are_acyclic() {
        assert_eq!(assert_acyclic(&[]), Ok(()));
        assert_eq!(assert_acyclic(&[edge('c', 'b'), edge('b', 'a')]), Ok(()));
        assert_eq!(
            assert_acyclic(&[edge('d', 'b'), edge('d', 'c'), edge('b', 'a'), edge('c', 'a')]),
            Ok(())
        );
    }

    #[test]
    fn a_self_dependency_is_a_cycle() {
        assert_eq!(
            assert_acyclic(&[edge('a', 'a')]),
            Err(DomainError::DependencyCycle(vec![id('a'), id('a')]))
        );
    }

    #[test]
    fn a_long_cycle_is_reported_from_its_first_visited_node() {
        let result = assert_acyclic(&[edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]);
        assert_eq!(
            result,
            Err(DomainError::DependencyCycle(vec![id('a'), id('b'), id('c'), id('a')]))
        );
    }

    #[test]
    fn a_cycle_behind_an_acyclic_prefix_is_found() {
        let result =
            assert_acyclic(&[edge('1', '2'), edge('2', '3'), edge('3', '4'), edge('4', '2')]);
        assert_eq!(
            result,
            Err(DomainError::DependencyCycle(vec![id('2'), id('3'), id('4'), id('2')]))
        );
    }

    #[test]
    fn deep_chains_do_not_overflow_the_stack() {
        let ids: Vec<Id> = (0..20_000)
            .map(|index| Id::parse(&format!("0193a8f2-6c1e-7b41-9a2e-{index:012x}")).unwrap())
            .collect();
        let edges: Vec<DependencyEdge> = ids
            .windows(2)
            .map(|pair| DependencyEdge {
                task_id: pair[0].clone(),
                depends_on_task_id: pair[1].clone(),
            })
            .collect();
        assert_eq!(assert_acyclic(&edges), Ok(()));
    }
}
